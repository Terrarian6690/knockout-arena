import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  projectSnapshot,
  type GameState,
  type PlayerSpec,
} from "../../game";
import {
  createGameHost,
  DEFAULT_ROUND_DECISION_TIMEOUT_MS,
  type GameHost,
} from "../index";

/**
 * AUTO-LAUNCH ON TIMEOUT (Task 22).
 *
 * The decision deadline used to punish hesitation: a player who had aimed
 * carefully but not pressed Confirm lost the round entirely. Now a LOCKED
 * AIM is honoured — at the deadline that player launches along their
 * locked direction with their currently selected power.
 *
 * The rules pinned here:
 *   1  the deadline is 20 s and server-authoritative
 *   2  locked aim + no confirm  → auto-launch (locked direction, selected
 *      power; the CONFIG default when nothing was chosen)
 *   3  NO locked aim            → unchanged: stays put, not eliminated
 *   4  simultaneity: confirmed, auto-launched and idle players all
 *      resolve in ONE transition — never staggered
 *   5  privacy: an auto-launched aim/power is as private before the
 *      reveal as a manually confirmed one
 *   6  one path: auto-launch produces the same authoritative artefacts
 *      (lastLaunch reveal, consumed aim) as a manual confirm
 *
 * Host-level with a FAKE clock and manual ticks, matching
 * roundDeadline.test.ts: the deadline is evaluated inside tick(), so the
 * boundaries are exact and nothing has to wait in real time.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

function specs(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i + 1}`,
  }));
}

const liveHosts: GameHost[] = [];
function host(options: {
  players: PlayerSpec[];
  clock?: () => number;
  roundDecisionTimeoutMs?: number;
}): GameHost {
  const h = createGameHost(options);
  liveHosts.push(h);
  return h;
}

afterEach(() => {
  for (const h of liveHosts) h.destroy();
  liveHosts.length = 0;
});

function stateOf(h: GameHost): GameState {
  return deserializeGameState(h.serializedState());
}

function pawn(h: GameHost, id: string) {
  return stateOf(h).pawns.find((p) => p.id === id)!;
}

/** Run the physics until the round settles back into aiming. */
function pumpUntilSettled(h: GameHost, max = 2000): void {
  for (let i = 0; i < max; i += 1) {
    if (stateOf(h).phase !== "moving") return;
    h.tick();
  }
}

/** Every phase the host published, in order. */
function phaseLog(h: GameHost): () => GameState["phase"][] {
  const phases: GameState["phase"][] = [];
  h.onStateChange((s) => phases.push(deserializeGameState(s).phase));
  return () => phases;
}

// ──────────────────────────────────────────────────────────────────────
// 1 — the duration itself
// ──────────────────────────────────────────────────────────────────────

describe("the aiming phase lasts 30 seconds, authoritatively", () => {
  it("arms a 30 s deadline from the server's own clock", () => {
    let now = 7_000;
    const h = host({ players: specs(2), clock: () => now });
    expect(DEFAULT_ROUND_DECISION_TIMEOUT_MS).toBe(30_000);
    expect(h.roundDeadline()).toBe(37_000);
  });

  it("does not resolve at the old 10 s mark — the window really is longer", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });

    now = 10_000; // where the round used to end
    h.tick();
    expect(stateOf(h).phase).toBe("aiming"); // still deciding

    now = 29_999;
    h.tick();
    expect(stateOf(h).phase).toBe("aiming"); // not a millisecond early

    now = 30_000;
    h.tick();
    expect(stateOf(h).phase).toBe("moving"); // exactly on time
  });

  it("leaves the match limit and the shrink schedule alone", () => {
    // Task 22 changes ONE duration. These are the neighbours it must not
    // have touched. (The match limit itself is now 6 minutes.)
    expect(CONFIG.match.durationMs).toBe(360_000);
    expect(CONFIG.arena.shrink.everyRounds).toBe(3);
    expect(CONFIG.power.default).toBe(3);
    expect(CONFIG.power.min).toBe(1);
    expect(CONFIG.power.max).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2 — the new behaviour
// ──────────────────────────────────────────────────────────────────────

describe("a locked aim is honoured when the timer expires", () => {
  it("launches the locked direction with the selected power", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    const before = pawn(h, "p0").position;

    // p0 aims at the centre and picks power 4 — but never confirms.
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 4 });
    expect(pawn(h, "p0").confirmed).toBe(false);

    now = 30_000;
    h.tick();

    // The reveal carries the aim they locked and the power they chose.
    const launch = pawn(h, "p0").lastLaunch;
    expect(launch).not.toBeNull();
    expect(launch!.power).toBe(4);
    // Aimed at the centre, so the direction points from the pawn to it.
    const expected = Math.hypot(CX - before.x, CY - before.y);
    expect(launch!.direction.x).toBeCloseTo((CX - before.x) / expected, 6);
    expect(launch!.direction.y).toBeCloseTo((CY - before.y) / expected, 6);

    pumpUntilSettled(h);
    const after = pawn(h, "p0").position;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1);
  });

  it("uses the CONFIG default power when none was ever chosen", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY }); // aim only

    now = 30_000;
    h.tick();

    const launch = pawn(h, "p0").lastLaunch!;
    expect(launch.power).toBe(CONFIG.power.default);
    expect(launch.power).toBe(3); // the value that default resolves to
  });

  it("carries a power chosen in an EARLIER round into the auto-launch", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });

    // Round 1: p0 picks power 2 (gentle: an inward launch that survives)
    // and plays normally.
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 2 });
    h.submitCommand({ type: "confirmLaunch", playerId: "p0" });
    now = 30_000;
    h.tick();
    pumpUntilSettled(h);
    expect(stateOf(h).phase).toBe("aiming"); // round 2 is open

    // Round 2: p0 only aims. Power is sticky, so 2 must come along —
    // NOT the CONFIG default, which would prove nothing was carried.
    const deadline2 = h.roundDeadline()!;
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    now = deadline2;
    h.tick();
    expect(pawn(h, "p0").lastLaunch!.power).toBe(2);
    expect(CONFIG.power.default).not.toBe(2); // the assertion has teeth
  });

  it("consumes the aim, so it cannot fire again next round", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });

    now = 30_000;
    h.tick();
    pumpUntilSettled(h);

    // A brand-new round: p0 does nothing at all this time.
    const settled = pawn(h, "p0").position;
    const deadline2 = h.roundDeadline()!;
    now = deadline2;
    h.tick();
    pumpUntilSettled(h);

    const after = pawn(h, "p0").position;
    expect(after.x).toBeCloseTo(settled.x, 6);
    expect(after.y).toBeCloseTo(settled.y, 6);
  });

  it("produces exactly the same artefacts as a manual confirm", () => {
    // Two hosts, identical setup; one player confirms, the other lets the
    // clock do it. The authoritative outcome must be indistinguishable.
    let nowA = 0;
    const manual = host({ players: specs(2), clock: () => nowA });
    manual.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    manual.submitCommand({ type: "setPower", playerId: "p0", power: 4 });
    manual.submitCommand({ type: "confirmLaunch", playerId: "p0" });
    nowA = 30_000;
    manual.tick();
    pumpUntilSettled(manual);

    let nowB = 0;
    const auto = host({ players: specs(2), clock: () => nowB });
    auto.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    auto.submitCommand({ type: "setPower", playerId: "p0", power: 4 });
    nowB = 30_000; // no confirm — the deadline does it
    auto.tick();
    pumpUntilSettled(auto);

    const a = pawn(manual, "p0");
    const b = pawn(auto, "p0");
    expect(b.lastLaunch).toEqual(a.lastLaunch);
    expect(b.position.x).toBeCloseTo(a.position.x, 6);
    expect(b.position.y).toBeCloseTo(a.position.y, 6);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3 — the untouched case
// ──────────────────────────────────────────────────────────────────────

describe("a player who locked nothing is unaffected (regression pin)", () => {
  it("stays exactly put, is not eliminated, and reveals no launch", () => {
    let now = 0;
    const h = host({ players: specs(3), clock: () => now });
    const before = stateOf(h).pawns.map((p) => ({ ...p.position }));

    now = 30_000; // nobody did anything at all
    h.tick();
    expect(stateOf(h).phase).toBe("moving"); // the round still resolves
    pumpUntilSettled(h);

    const after = stateOf(h);
    expect(after.pawns.map((p) => ({ ...p.position }))).toEqual(before);
    expect(after.pawns.every((p) => !p.eliminated)).toBe(true);
    expect(after.pawns.every((p) => p.lastLaunch === null)).toBe(true);
    expect(after.phase).toBe("aiming"); // a fresh round opened
  });

  it("choosing only a POWER is not a locked aim — still no launch", () => {
    // The distinction is the aim, not "touched any control". Power alone
    // never implies a direction, so it must not launch anyone.
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    const before = { ...pawn(h, "p0").position };
    h.submitCommand({ type: "setPower", playerId: "p0", power: 5 });

    now = 30_000;
    h.tick();
    pumpUntilSettled(h);

    const after = pawn(h, "p0");
    expect(after.lastLaunch).toBeNull();
    expect(after.position.x).toBeCloseTo(before.x, 6);
    expect(after.position.y).toBeCloseTo(before.y, 6);
    expect(after.eliminated).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4 — simultaneity
// ──────────────────────────────────────────────────────────────────────

describe("everyone still resolves together", () => {
  it("mixes confirmed, auto-launched and idle players in ONE transition", () => {
    let now = 0;
    const h = host({ players: specs(3), clock: () => now });
    const before = Object.fromEntries(
      stateOf(h).pawns.map((p) => [p.id, { ...p.position }])
    );
    const phases = phaseLog(h);

    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 2 });
    h.submitCommand({ type: "confirmLaunch", playerId: "p0" }); // manual
    h.submitCommand({ type: "aim", playerId: "p1", x: CX, y: CY }); // auto
    h.submitCommand({ type: "setPower", playerId: "p1", power: 2 });
    // p2 does nothing.

    // One player confirming must NOT start the round early.
    expect(stateOf(h).phase).toBe("aiming");

    now = 30_000;
    h.tick();

    // Both launches are revealed in the same snapshot — not staggered.
    const moving = stateOf(h);
    expect(moving.phase).toBe("moving");
    expect(moving.pawns.find((p) => p.id === "p0")!.lastLaunch).not.toBeNull();
    expect(moving.pawns.find((p) => p.id === "p1")!.lastLaunch).not.toBeNull();
    expect(moving.pawns.find((p) => p.id === "p2")!.lastLaunch).toBeNull();

    pumpUntilSettled(h);
    const after = stateOf(h);
    const moved = (id: string) => {
      const p = after.pawns.find((q) => q.id === id)!;
      return Math.hypot(p.position.x - before[id]!.x, p.position.y - before[id]!.y);
    };
    expect(moved("p0")).toBeGreaterThan(1);
    expect(moved("p1")).toBeGreaterThan(1);
    expect(moved("p2")).toBeLessThan(1e-9);

    // Exactly one aiming→moving transition: the round resolved once, for
    // everyone, rather than once per player.
    const log = phases();
    let transitions = 0;
    for (let i = 1; i < log.length; i += 1) {
      if (log[i - 1] === "aiming" && log[i] === "moving") transitions += 1;
    }
    expect(transitions).toBe(1);
  });

  it("still resolves early when everyone confirms — the deadline is a backstop", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    for (const id of ["p0", "p1"]) {
      h.submitCommand({ type: "aim", playerId: id, x: CX, y: CY });
      h.submitCommand({ type: "confirmLaunch", playerId: id });
    }
    // No tick, no clock movement: the last confirmation resolved it.
    expect(stateOf(h).phase).toBe("moving");
    expect(h.roundDeadline()).toBeNull();
  });

  it("a confirm arriving in the same tick as the deadline resolves once", () => {
    // The race: the host checks the deadline inside tick(). A confirm
    // landing in that same instant must not produce two resolutions.
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    const phases = phaseLog(h);
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "aim", playerId: "p1", x: CX, y: CY });

    now = 30_000;
    h.submitCommand({ type: "confirmLaunch", playerId: "p0" });
    h.submitCommand({ type: "confirmLaunch", playerId: "p1" }); // resolves here
    h.tick(); // the deadline finds the round already gone

    const log = phases();
    let transitions = 0;
    for (let i = 1; i < log.length; i += 1) {
      if (log[i - 1] === "aiming" && log[i] === "moving") transitions += 1;
    }
    expect(transitions).toBe(1);
    expect(stateOf(h).phase).toBe("moving");
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5 — privacy
// ──────────────────────────────────────────────────────────────────────

describe("an auto-launched choice is as private as a confirmed one", () => {
  it("hides a locked aim from opponents right up to the reveal", () => {
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 5 });

    // Mid-aiming: p1 must not be able to see any of p0's intent.
    const spy = projectSnapshot(stateOf(h), "p1");
    const p0AsSeenByP1 = spy.pawns.find((p) => p.id === "p0")!;
    expect(p0AsSeenByP1.launch).toBeNull();
    expect(spy.power).toBe(CONFIG.power.default); // p1's own power, not p0's
    expect(JSON.stringify(spy)).not.toContain('"power":5');

    // p0's own view does carry it — privacy, not blindness.
    const own = projectSnapshot(stateOf(h), "p0");
    expect(own.power).toBe(5);
    expect(own.aimDirection).not.toBeNull();

    // After the deadline, the auto-launch is public fact for everyone.
    now = 30_000;
    h.tick();
    const revealed = projectSnapshot(stateOf(h), "p1");
    expect(revealed.pawns.find((p) => p.id === "p0")!.launch).not.toBeNull();
    expect(revealed.pawns.find((p) => p.id === "p0")!.launch!.power).toBe(5);
  });

  it("keeps NOTHING to leak: the state itself is empty during aiming", () => {
    // Defence in depth. projectSnapshot's phase gate is one layer, but a
    // locked aim must also be absent from the AUTHORITATIVE state's
    // reveal field — so even a broken projection cannot expose it. (This
    // is why disabling the gate alone does not leak: `lastLaunch` is
    // nulled when a fresh aiming round opens.) Both layers are pinned
    // because the auto-launch path now populates that field for players
    // who never pressed Confirm.
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    // Power 2: gentle enough that the pawn survives the launch, so the
    // match reaches a SECOND aiming round and the re-clearing below is
    // actually observable.
    h.submitCommand({ type: "setPower", playerId: "p0", power: 2 });

    const during = stateOf(h);
    expect(during.phase).toBe("aiming");
    expect(during.pawns.every((p) => p.lastLaunch === null)).toBe(true);

    // It appears only at the reveal…
    now = 30_000;
    h.tick();
    expect(pawn(h, "p0").lastLaunch).not.toBeNull();

    // …and is cleared again the moment the next aiming round opens.
    pumpUntilSettled(h);
    const next = stateOf(h);
    expect(next.phase).toBe("aiming");
    expect(next.pawns.every((p) => p.lastLaunch === null)).toBe(true);
  });

  it("does not leak through the confirmed flag either", () => {
    // An auto-launch candidate is NOT confirmed, and nothing in the
    // public projection should hint that they have aimed.
    let now = 0;
    const h = host({ players: specs(2), clock: () => now });
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });

    const spy = projectSnapshot(stateOf(h), "p1");
    const p0 = spy.pawns.find((p) => p.id === "p0")!;
    expect(p0.confirmed).toBe(false);
    expect(p0.launch).toBeNull();
    expect("aim" in p0).toBe(false);
    expect("aimDirection" in p0).toBe(false);
  });
});
