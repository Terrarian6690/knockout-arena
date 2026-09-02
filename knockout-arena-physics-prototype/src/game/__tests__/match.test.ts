import { describe, expect, it } from "vitest";
import { CONFIG, launchSpeedFor } from "../config";
import { createArena, floorRadius } from "../arena";
import { createGame, type GameHandle } from "../game";
import { projectSnapshot } from "../project";
import {
  serializeGameState,
  deserializeGameState,
  type GameState,
  type PawnState,
} from "../state";
import type { PlayerSpec } from "../game";

/**
 * N-player match integration suite — SIMULTANEOUS ROUNDS.
 *
 * The engine is player-count agnostic: a match is a roster of pawns, a
 * shared round phase (no turn queue, no current player), per-pawn
 * aim/power/confirmation, per-pawn elimination, and a finished phase with
 * a winner derived purely from elimination state. These tests drive whole
 * matches (2/3/4 players) through commands and fixed-tick updates,
 * including physical knockouts (a mover shoving an opponent over the rim),
 * and verify serialization/replay determinism.
 *
 * Round model under test:
 *   - every alive player chooses independently during "aiming";
 *   - confirmLaunch locks that player's choice but does NOT move anyone;
 *   - when ALL alive players confirmed — or the server submits
 *     `resolveRound` (the decision deadline) — all confirmed movements
 *     start together in ONE transition;
 *   - unconfirmed pawns stay exactly where they are;
 *   - after everything settles, a fresh aiming round begins.
 *
 * Physical facts used below (see physics.test.ts for the derivations):
 *   - max travel at power 5 ≈ 225 world units, so crafted states place the
 *     victim close to the mover (a direct head-on p5 hit transfers ≈ 0.79 of
 *     the mover's contact speed — more than the 2.3 rim pass-over threshold);
 *   - the rim pass-over decision is re-derived for EVERY alive pawn each
 *     tick, so a shoved opponent flies over the rim exactly like a mover does.
 */

const DT = CONFIG.simulation.fixedTimestepMs;
const ARENA = createArena();
const FLOOR = floorRadius(ARENA);
const PAWN_R = CONFIG.pawn.radius;
const CX = ARENA.centerX;
const CY = ARENA.centerY;

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** A hand-crafted pawn at an arbitrary position (spawn = position). */
function pawnAt(
  id: string,
  x: number,
  y: number,
  extra: Partial<PawnState> = {}
): PawnState {
  return {
    id,
    name: `Player ${id}`,
    colorIndex: Number(id.slice(1)),
    radius: PAWN_R,
    spawnX: x,
    spawnY: y,
    eliminated: false,
    power: CONFIG.power.default,
    confirmed: false,
    aim: { active: false, direction: { x: 0, y: -1 } },
    position: { x, y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    ...extra,
  };
}

/** Craft a full match state from pawn placements. */
function matchState(
  pawns: PawnState[],
  opts: { phase?: GameState["phase"]; settleTicks?: number } = {}
): GameState {
  return {
    phase: opts.phase ?? "aiming",
    winnerId: null,
    round: { settleTicks: opts.settleTicks ?? 0 },
    pawns,
  };
}

/** Update until the phase leaves "moving" (or maxFrames). */
function pump(g: GameHandle, maxFrames = 900): number {
  for (let i = 0; i < maxFrames; i++) {
    g.update(DT);
    if (g.getState().phase !== "moving") return i + 1;
  }
  return maxFrames;
}

/** A player's full independent choice: aim + power + confirm. */
function choose(
  g: GameHandle,
  playerId: string,
  target: { x: number; y: number },
  power: number
) {
  g.applyCommand({ type: "aim", playerId, x: target.x, y: target.y });
  g.applyCommand({ type: "setPower", playerId, power });
  g.applyCommand({ type: "confirmLaunch", playerId });
}

/** Choose a launch toward the arena center (always settles safely). */
function chooseInward(g: GameHandle, playerId: string, power = 2) {
  choose(g, playerId, { x: CX, y: CY }, power);
}

/** Choose a launch straight at the rim the direction points to. */
function chooseOutward(
  g: GameHandle,
  playerId: string,
  dir: { x: number; y: number },
  power = 5
) {
  choose(g, playerId, { x: CX + dir.x * 400, y: CY + dir.y * 400 }, power);
}

/** The server's decision deadline: resolve the round with the current
 *  confirmations (confirmed players move, unconfirmed players stay). */
function deadlineResolve(g: GameHandle) {
  g.dispatch({ type: "resolveRound" });
}

/**
 * The physical knockout setup: the mover sits 45 units behind the victim,
 * both on the same radial line, the victim just inside the rim pass-over
 * zone. A p5 head-on launch transfers enough speed to shove the victim over
 * the rim while the mover stays on the floor.
 */
function knockoutSetup(
  moverId: string,
  victimId: string,
  extraPawns: PawnState[] = []
): GameState {
  // Radial direction "down" (toward the bottom rim); victim at distance 240
  // from the center, mover 45 units behind it.
  const victim = pawnAt(victimId, CX, CY + 240);
  const mover = pawnAt(moverId, CX, CY + 195);
  return matchState([mover, victim, ...extraPawns]);
}

/** Player specs p0..pN-1. */
function specs(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i + 1}`,
  }));
}

const distFromCenter = (p: { x: number; y: number }) => Math.hypot(p.x - CX, p.y - CY);

/** Alive pawn ids of a state, in roster order. */
const aliveIds = (s: GameState) => s.pawns.filter((p) => !p.eliminated).map((p) => p.id);

// ────────────────────────────────────────────────────────────────────────
// Match creation / rosters
// ────────────────────────────────────────────────────────────────────────

describe("N-player match creation", () => {
  it("defaults to exactly the classic single-player match (p0)", () => {
    const g = createGame();
    const s = g.getState();
    expect(s.pawns.map((p) => p.id)).toEqual(["p0"]);
    expect(s.pawns[0].name).toBe("Player 1");
    expect(s.pawns[0].position).toEqual({ x: CX, y: CY - 240 });
    expect(s.phase).toBe("aiming");
    expect(s.round.settleTicks).toBe(0);
    g.destroy();
  });

  it.each([2, 3, 4, 5])("spawns %i players deterministically on a circle", (n) => {
    const g = createGame({ players: specs(n) });
    const s = g.getState();
    expect(s.pawns).toHaveLength(n);
    // Seat i sits at angle -π/2 + i·2π/n, just inside the floor; the first
    // seat is the classic top spawn.
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const r = FLOOR - PAWN_R - 8;
      const p = s.pawns[i];
      expect(p.id).toBe(`p${i}`);
      expect(p.position.x).toBeCloseTo(CX + Math.cos(angle) * r, 6);
      expect(p.position.y).toBeCloseTo(CY + Math.sin(angle) * r, 6);
      expect(p.colorIndex).toBe(i);
      expect(p.eliminated).toBe(false);
      expect(p.power).toBe(CONFIG.power.default);
      expect(p.confirmed).toBe(false); // nobody has chosen yet
      expect(p.aim.active).toBe(false);
    }
    g.destroy();
  });

  it("keeps opposite spawns maximally apart (2 players top/bottom)", () => {
    const g = createGame({ players: specs(2) });
    const [a, b] = g.getState().pawns;
    expect(a.position).toEqual({ x: CX, y: CY - 240 });
    expect(b.position).toEqual({ x: CX, y: CY + 240 });
    g.destroy();
  });

  it("honors custom names and color indices", () => {
    const g = createGame({
      players: [
        { id: "ada", name: "Ada", colorIndex: 3 },
        { id: "bob", name: "Bob" },
      ],
    });
    const s = g.getState();
    expect(s.pawns.map((p) => p.name)).toEqual(["Ada", "Bob"]);
    expect(s.pawns.map((p) => p.colorIndex)).toEqual([3, 1]); // bob defaults to seat 1
    g.destroy();
  });

  it("rejects empty rosters and duplicate player ids", () => {
    expect(() => createGame({ players: [] })).toThrow(/at least one player/);
    expect(() =>
      createGame({ players: [{ id: "p0", name: "A" }, { id: "p0", name: "B" }] })
    ).toThrow(/duplicate player id/);
    expect(() => createGame({ players: [{ id: "", name: "A" }] })).toThrow(
      /non-empty strings/
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Simultaneous rounds — the core round model (required spec tests 1–7, 13)
// ────────────────────────────────────────────────────────────────────────

describe("simultaneous rounds — choosing and resolving", () => {
  it("[1] two players both choose before any movement happens", () => {
    const g = createGame({ players: specs(2) });
    // Both players make their full choice while the phase is still "aiming":
    // p0 first, then p1 — nobody moves in between.
    chooseInward(g, "p0", 3);
    expect(g.getState().phase).toBe("aiming"); // p0 done choosing, no movement
    const p0Pos = { ...g.getState().pawns[0].position };
    for (let i = 0; i < 10; i++) g.update(DT);
    expect(g.getState().pawns[0].position).toEqual(p0Pos); // p0 did not move alone
    chooseInward(g, "p1", 2); // p1 chooses while the round is still open
    // Only now — with everyone's choice in — does the movement phase begin.
    expect(g.getState().phase).toBe("moving");
    g.destroy();
  });

  it("[2] one player confirming does NOT start movement", () => {
    const g = createGame({ players: specs(2) });
    const p0Start = { ...g.getState().pawns[0].position };
    chooseInward(g, "p0", 3);
    expect(g.getState().phase).toBe("aiming");
    // Even after several frames: the round waits for p1 (or the deadline).
    for (let i = 0; i < 30; i++) g.update(DT);
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().pawns[0].position).toEqual(p0Start);
    expect(g.getState().pawns[0].confirmed).toBe(true); // choice is locked, though
    g.destroy();
  });

  it("[3] the last confirmation starts everyone's movement together", () => {
    const g = createGame({ players: specs(2) });
    chooseInward(g, "p0", 3);
    chooseInward(g, "p1", 2); // completes the set → round begins
    expect(g.getState().phase).toBe("moving");
    pump(g);
    expect(g.getState().phase).toBe("aiming"); // settled → next round
    // BOTH pawns left their spawns (each moved toward the center).
    const s = g.getState();
    expect(s.pawns[0].position.y).toBeGreaterThan(CY - 240 + 20);
    expect(s.pawns[1].position.y).toBeLessThan(CY + 240 - 20);
    g.destroy();
  });

  it("[4] four players confirm independently; only the last one triggers the round", () => {
    const g = createGame({ players: specs(4) });
    chooseInward(g, "p2", 1); // any order — p2 first
    chooseInward(g, "p0", 2);
    chooseInward(g, "p3", 1);
    expect(g.getState().phase).toBe("aiming"); // three of four in
    chooseInward(g, "p1", 2); // completes the set
    expect(g.getState().phase).toBe("moving");
    pump(g);
    expect(g.getState().phase).toBe("aiming");
    // Every pawn moved inward from its circle spawn.
    for (const p of g.getState().pawns) {
      expect(distFromCenter(p.position)).toBeLessThan(FLOOR - PAWN_R - 8 - 15);
    }
    g.destroy();
  });

  it("[5] an incomplete set never resolves on its own (no timeout in the engine)", () => {
    const g = createGame({ players: specs(3) });
    chooseInward(g, "p0", 2);
    chooseInward(g, "p1", 2); // p2 never confirms
    for (let i = 0; i < 300; i++) g.update(DT);
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().pawns.filter((p) => p.confirmed)).toHaveLength(2);
    g.destroy();
  });

  it("[6] the deadline (resolveRound) moves only the confirmed players", () => {
    const g = createGame({ players: specs(4) });
    const starts = g.getState().pawns.map((p) => ({ ...p.position }));
    chooseInward(g, "p0", 4); // ONLY p0 confirmed
    deadlineResolve(g); // the server's decision deadline fires
    expect(g.getState().phase).toBe("moving");
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("aiming");
    // p0 moved; p1, p2, p3 stayed exactly at their positions.
    expect(s.pawns[0].position.y).toBeGreaterThan(starts[0].y + 20);
    expect(s.pawns[1].position).toEqual(starts[1]);
    expect(s.pawns[2].position).toEqual(starts[2]);
    expect(s.pawns[3].position).toEqual(starts[3]);
    g.destroy();
  });

  it("[7] an unconfirmed player keeps the exact same position through the round", () => {
    const g = createGame({ players: specs(2) });
    const p1Start = { ...g.getState().pawns[1].position };
    chooseInward(g, "p0", 5);
    deadlineResolve(g);
    pump(g);
    expect(g.getState().pawns[1].position).toEqual(p1Start);
    // …and the unconfirmed player can choose in the NEXT round normally.
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().pawns[1].confirmed).toBe(false);
    chooseInward(g, "p1", 2);
    chooseInward(g, "p0", 2);
    expect(g.getState().phase).toBe("moving");
    pump(g);
    expect(g.getState().pawns[1].position.y).toBeLessThan(p1Start.y - 20);
    g.destroy();
  });

  it("[13] all confirmed movements start in the SAME simulation transition", () => {
    const g = createGame({ players: specs(2) });
    chooseInward(g, "p0", 3);
    chooseInward(g, "p1", 2); // completes the set
    // BEFORE any update()/physics step: both pawns already carry their full
    // launch velocity — the impulses were applied in one synchronous
    // transition, never "A moves, settles, then B".
    const s = g.getState();
    expect(s.phase).toBe("moving");
    const v0 = Math.hypot(s.pawns[0].velocity.x, s.pawns[0].velocity.y);
    const v1 = Math.hypot(s.pawns[1].velocity.x, s.pawns[1].velocity.y);
    // Both carry their full launch speed already — p0's power-3 speed…
    expect(v0).toBeCloseTo(launchSpeedFor(3), 6);
    // …and p1's power-2 speed, from the SAME transition.
    expect(v1).toBeCloseTo(launchSpeedFor(2), 6);
    // Neither pawn has moved yet (no step has run) — they start TOGETHER.
    expect(s.pawns[0].position.y).toBe(CY - 240);
    expect(s.pawns[1].position.y).toBe(CY + 240);
    g.destroy();
  });

  it("[13b] the same holds at the deadline: one transition for every confirmed pawn", () => {
    const g = createGame({ players: specs(3) });
    chooseInward(g, "p0", 3);
    chooseInward(g, "p2", 3);
    deadlineResolve(g);
    const s = g.getState();
    expect(s.phase).toBe("moving");
    expect(Math.hypot(s.pawns[0].velocity.x, s.pawns[0].velocity.y)).toBeCloseTo(launchSpeedFor(3), 6);
    expect(Math.hypot(s.pawns[2].velocity.x, s.pawns[2].velocity.y)).toBeCloseTo(launchSpeedFor(3), 6);
    expect(Math.hypot(s.pawns[1].velocity.x, s.pawns[1].velocity.y)).toBe(0); // unconfirmed
    g.destroy();
  });

  it("[14] there is no current-player/turn-queue anywhere in the authoritative model", () => {
    const g = createGame({ players: specs(3) });
    // Play a full round plus a knockout so every phase is exercised.
    chooseInward(g, "p0", 2);
    chooseInward(g, "p1", 2);
    chooseInward(g, "p2", 2);
    pump(g);
    chooseInward(g, "p0", 2);
    chooseInward(g, "p1", 2);
    chooseInward(g, "p2", 2);
    pump(g);
    // Structural: no active-pawn/current-player concept on the state object.
    const state = g.getState();
    expect("turn" in state).toBe(false);
    expect("queue" in state).toBe(false);
    expect("activePawnId" in state).toBe(false);
    expect("activeIndex" in state).toBe(false);
    // …and none appears anywhere in the serialized authoritative state or
    // the client-facing snapshot of any viewer.
    const wire = serializeGameState(g.getState());
    expect(wire).not.toMatch(/"turn"/);
    expect(wire).not.toMatch(/queue/);
    expect(wire).not.toMatch(/activePawnId/);
    for (const viewer of ["p0", "p1", "p2", null]) {
      const snap = projectSnapshot(g.getState(), viewer);
      expect("activePawnId" in snap).toBe(false);
      expect(JSON.stringify(snap)).not.toMatch(/activePawnId/);
    }
    g.destroy();
  });

  it("[15] one player's commands never touch another player's intent", () => {
    const g = createGame({ players: specs(2) });
    // p0 chooses; p1 chooses differently.
    choose(g, "p0", { x: CX, y: CY + 100 }, 5);
    choose(g, "p1", { x: CX, y: CY - 100 }, 2);
    const s = g.getState();
    expect(s.pawns[0].power).toBe(5);
    expect(s.pawns[1].power).toBe(2);
    expect(s.pawns[0].aim.direction.y).toBeGreaterThan(0); // p0 aims down…
    expect(s.pawns[1].aim.direction.y).toBeLessThan(0); // …p1 aims up
    // More p0 commands cannot alter p1's stored choice.
    g.applyCommand({ type: "setPower", playerId: "p0", power: 1 });
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY - 100 });
    const s2 = g.getState();
    expect(s2.pawns[1].power).toBe(2);
    expect(s2.pawns[1].aim.direction.y).toBeLessThan(0);
    expect(s2.pawns[1].confirmed).toBe(true);
    g.destroy();
  });

  it("confirmation locks the choice: aim/setPower/confirm are rejected as already-confirmed", () => {
    const g = createGame({ players: specs(2) });
    chooseInward(g, "p0", 3);
    const locked = { ...g.getState().pawns[0].aim.direction };
    expect(g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY - 100 })).toEqual({
      ok: false,
      reason: "already-confirmed",
    });
    expect(g.applyCommand({ type: "setPower", playerId: "p0", power: 1 })).toEqual({
      ok: false,
      reason: "already-confirmed",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: "p0" })).toEqual({
      ok: false,
      reason: "already-confirmed",
    });
    // The locked choice is intact.
    expect(g.getState().pawns[0].aim.direction).toEqual(locked);
    expect(g.getState().pawns[0].power).toBe(3);
    // The OTHER player is unaffected and may still choose freely.
    expect(g.applyCommand({ type: "setPower", playerId: "p1", power: 4 })).toEqual({ ok: true });
    g.destroy();
  });

  it("resolveRound is rejected outside the aiming phase", () => {
    const g = createGame({ players: specs(2) });
    chooseInward(g, "p0", 2);
    chooseInward(g, "p1", 2);
    expect(g.applyCommand({ type: "resolveRound" })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    pump(g);
    g.destroy();
  });

  it("a round with zero confirmations resolves as an empty round (deadline stand-in)", () => {
    const g = createGame({ players: specs(2) });
    const starts = g.getState().pawns.map((p) => ({ ...p.position }));
    deadlineResolve(g); // nobody chose anything
    expect(g.getState().phase).toBe("moving");
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("aiming"); // empty round settles instantly
    expect(s.pawns[0].position).toEqual(starts[0]);
    expect(s.pawns[1].position).toEqual(starts[1]);
    g.destroy();
  });

  it("eliminated players do not count towards the confirmation set", () => {
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5); // p0 confirmed; p1 victim silent
    // p1 AND p2 (both alive, unconfirmed) block the early end…
    expect(g.getState().phase).toBe("aiming");
    chooseInward(g, "p1", 1); // victim confirms…
    expect(g.getState().phase).toBe("aiming"); // …but p2 still holds the round open
    chooseInward(g, "p2", 1); // now everyone alive is in
    expect(g.getState().phase).toBe("moving");
    pump(g);
    // …and after p1 is eliminated by the shove, the next round needs only
    // the survivors' confirmations.
    const s = g.getState();
    expect(s.pawns[1].eliminated).toBe(true);
    expect(s.phase).toBe("aiming");
    chooseInward(g, "p0", 1);
    chooseInward(g, "p2", 1); // p1 is gone — not part of any set anymore
    expect(g.getState().phase).toBe("moving");
    pump(g);
    expect(g.getState().phase).toBe("aiming");
    g.destroy();
  });

  it("a fresh round resets confirmations and aim, but keeps power selections", () => {
    const g = createGame({ players: specs(2) });
    chooseInward(g, "p0", 4);
    chooseInward(g, "p1", 2);
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("aiming");
    expect(s.pawns.every((p) => !p.confirmed)).toBe(true);
    expect(s.pawns.every((p) => !p.aim.active)).toBe(true); // fresh aim
    expect(s.pawns[0].power).toBe(4); // power persists (standing choice)
    expect(s.pawns[1].power).toBe(2);
    g.destroy();
  });

  it("rounds chain: aiming → moving → aiming, over and over", () => {
    const g = createGame({ players: specs(3) });
    for (let round = 0; round < 3; round++) {
      for (const id of aliveIds(g.getState())) chooseInward(g, id, 1);
      expect(g.getState().phase).toBe("moving");
      pump(g);
      expect(g.getState().phase).toBe("aiming");
      expect(g.getState().winnerId).toBeNull();
    }
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Participation and ownership gates
// ────────────────────────────────────────────────────────────────────────

describe("command gates", () => {
  it("every alive player may act simultaneously — nobody is rejected as 'not your turn'", () => {
    const g = createGame({ players: specs(3) });
    // All three players choose in the SAME aiming phase, any order.
    for (const id of ["p2", "p0", "p1"]) {
      expect(g.applyCommand({ type: "setPower", playerId: id, power: 3 })).toEqual({ ok: true });
      expect(g.applyCommand({ type: "aim", playerId: id, x: CX, y: CY })).toEqual({ ok: true });
      expect(g.applyCommand({ type: "confirmLaunch", playerId: id })).toEqual({ ok: true });
    }
    expect(g.getState().phase).toBe("moving");
    g.destroy();
  });

  it("rejects unknown players regardless of phase", () => {
    const g = createGame({ players: specs(2) });
    expect(g.applyCommand({ type: "aim", playerId: "p7", x: 1, y: 1 })).toEqual({
      ok: false,
      reason: "unknown-player",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: "p7" })).toEqual({
      ok: false,
      reason: "unknown-player",
    });
    g.destroy();
  });

  it("rejects commands while the round is resolving (wrong-phase)", () => {
    const g = createGame({ players: specs(2) });
    chooseInward(g, "p0", 2);
    chooseInward(g, "p1", 2); // round is moving
    for (const id of ["p0", "p1"]) {
      expect(g.applyCommand({ type: "aim", playerId: id, x: CX, y: CY })).toEqual({
        ok: false,
        reason: "wrong-phase",
      });
      expect(g.applyCommand({ type: "confirmLaunch", playerId: id })).toEqual({
        ok: false,
        reason: "wrong-phase",
      });
    }
    pump(g);
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-pawn aim and power
// ────────────────────────────────────────────────────────────────────────

describe("per-pawn aim and power", () => {
  it("keeps each player's power selection independent and persistent", () => {
    const g = createGame({ players: specs(2) });
    // Round 1: p0 picks 4, p1 keeps the default.
    g.applyCommand({ type: "setPower", playerId: "p0", power: 4 });
    chooseInward(g, "p0", 4);
    chooseInward(g, "p1", CONFIG.power.default);
    pump(g);
    // Round 2: each projection still shows the player's OWN power.
    expect(projectSnapshot(g.getState(), "p0").power).toBe(4);
    expect(projectSnapshot(g.getState(), "p1").power).toBe(CONFIG.power.default);

    // p1 picks 2 → after the round, p0's 4 survived, p1's 2 is stored.
    chooseInward(g, "p1", 2);
    chooseInward(g, "p0", 4);
    pump(g);
    expect(g.getState().pawns[0].power).toBe(4);
    expect(g.getState().pawns[1].power).toBe(2);
    g.destroy();
  });

  it("keeps each player's aim independent; consumed only by their own launch", () => {
    const g = createGame({ players: specs(2) });
    // Both aim during the same round — each in their own direction.
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + 200 }); // down
    g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY - 200 }); // up
    const s = g.getState();
    expect(s.pawns[0].aim.direction.y).toBeGreaterThan(0);
    expect(s.pawns[1].aim.direction.y).toBeLessThan(0);
    // Both confirm → both aims are consumed by the round's launches.
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    g.applyCommand({ type: "confirmLaunch", playerId: "p1" });
    const s2 = g.getState();
    expect(s2.pawns[0].aim.active).toBe(false); // consumed by the launch
    expect(s2.pawns[1].aim.active).toBe(false);
    g.destroy();
  });

  it("a new round opens a FRESH aim for everyone (unconfirmed aim does not carry over)", () => {
    const g = createGame({ players: specs(2) });
    // p1 aims but does NOT confirm; p0's round resolves at the deadline.
    g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY - 100 });
    chooseInward(g, "p0", 2);
    deadlineResolve(g);
    pump(g);
    // p1 did not move and never launched — and the new aiming round gives
    // everyone a fresh aim (the stored direction is kept only as a default).
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().pawns[1].aim.active).toBe(false);
    // p1 can of course aim again in the new round.
    expect(g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY - 100 })).toEqual({ ok: true });
    expect(g.getState().pawns[1].aim.active).toBe(true);
    g.destroy();
  });

  it("the projection exposes the VIEWER'S OWN controls (not 'the active pawn's')", () => {
    const g = createGame({ players: specs(3) });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    // p0 sees its own choice…
    const asP0 = projectSnapshot(g.getState(), "p0");
    expect(asP0.power).toBe(5);
    expect(asP0.isAiming).toBe(true);
    // …while p1 (who touched nothing) sees defaults, at the same time.
    const asP1 = projectSnapshot(g.getState(), "p1");
    expect(asP1.power).toBe(CONFIG.power.default);
    expect(asP1.isAiming).toBe(false);
    expect(asP1.aimDirection).toBeNull();
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Elimination during play (physical knockouts)
// ────────────────────────────────────────────────────────────────────────

describe("knocking an opponent over the rim", () => {
  it("[16] eliminates the victim mid-flight while the match is still moving", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5); // only p0 confirmed
    deadlineResolve(g); // the server resolves the round

    let sawVictimOutWhileMoving = false;
    for (let i = 0; i < 900; i++) {
      g.update(DT);
      const s = g.getState();
      const victim = s.pawns.find((p) => p.id === "p1")!;
      if (victim.eliminated && s.phase === "moving") sawVictimOutWhileMoving = true;
      if (s.phase !== "moving") break;
    }
    const s = g.getState();
    expect(sawVictimOutWhileMoving).toBe(true); // elimination ≠ phase change
    expect(s.pawns.find((p) => p.id === "p1")!.eliminated).toBe(true);
    expect(s.pawns.find((p) => p.id === "p0")!.eliminated).toBe(false);
    // The victim physically left the floor…
    expect(distFromCenter(s.pawns[1].position)).toBeGreaterThan(FLOOR + PAWN_R);
    // …the mover stayed on it.
    expect(distFromCenter(s.pawns[0].position)).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });

  it("[16] ends a two-player match with the mover as winner", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p0");
    g.destroy();
  });

  it("[16] continues the match with a bystander (3 players)", () => {
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);
    const s = g.getState();
    // Two pawns still active (p0 mover + p2 bystander): not finished.
    expect(s.phase).toBe("aiming");
    expect(s.winnerId).toBeNull();
    expect(aliveIds(s)).toEqual(["p0", "p2"]);
    // Eliminated pawns stay in the historical state.
    expect(s.pawns.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
    g.destroy();
  });

  it("[16] an eliminated player's commands are rejected as wrong-player", () => {
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g); // p1 eliminated, new round for p0 + p2
    expect(g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: "p1" })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
    // The survivors are still allowed.
    expect(g.applyCommand({ type: "setPower", playerId: "p2", power: 3 })).toEqual({ ok: true });
    expect(g.applyCommand({ type: "setPower", playerId: "p0", power: 3 })).toEqual({ ok: true });
    g.destroy();
  });

  it("the eliminated pawn becomes a non-collidable frozen ghost", () => {
    const run = (withGhost: boolean) => {
      const g = createGame();
      // Mover at the top, sliding down through where the ghost sits.
      const pawns = [
        pawnAt("p0", CX, CY - 50),
        pawnAt("p2", CX, CY - 240, { colorIndex: 2 }),
      ];
      if (withGhost) {
        pawns.push(pawnAt("p1", CX, CY + 50, { eliminated: true, colorIndex: 1 }));
      }
      g.loadState(matchState(pawns));
      choose(g, "p0", { x: CX, y: CY + 400 }, 4);
      deadlineResolve(g);
      const trace: number[] = [];
      for (let i = 0; i < 400; i++) {
        g.update(DT);
        const p = g.getState().pawns.find((pp) => pp.id === "p0")!;
        trace.push(p.position.x, p.position.y);
        if (g.getState().phase !== "moving") break;
      }
      g.destroy();
      return trace;
    };
    // Passing straight through the ghost must not deflect the mover.
    expect(run(true)).toEqual(run(false));
  });

  it("freezes the ghost in place (no background drift)", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g); // finished: p1 out, p0 winner
    const frozen = { ...g.getState().pawns[1].position };
    for (let i = 0; i < 120; i++) g.update(DT);
    expect(g.getState().pawns[1].position).toEqual(frozen);
    expect(g.getState().pawns[1].velocity).toEqual({ x: 0, y: 0 });
    g.destroy();
  });
});

describe("eliminating yourself (the mover leaves the arena)", () => {
  it("[16] hands the win to the opponent in a two-player match", () => {
    const g = createGame({ players: specs(2) });
    // p0 launches straight at its nearby top rim and flies out.
    choose(g, "p0", { x: CX, y: CY - 400 }, 5);
    deadlineResolve(g);
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p1");
    expect(s.pawns[0].eliminated).toBe(true);
    expect(s.pawns[1].eliminated).toBe(false);
    g.destroy();
  });

  it("[16] continues with the survivors in a three-player match", () => {
    const g = createGame({ players: specs(3) });
    choose(g, "p0", { x: CX, y: CY - 400 }, 5);
    deadlineResolve(g);
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("aiming"); // two pawns still active
    expect(s.pawns[0].eliminated).toBe(true);
    expect(aliveIds(s)).toEqual(["p1", "p2"]);
    g.destroy();
  });
});

describe("consecutive eliminations across rounds", () => {
  it("[16] p0 knocks out p1 in round 1, then p2 knocks out p0 in round 2 → p2 wins", () => {
    // Round 1: p0 shoves p1 over the bottom rim; p2 waits at the top.
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().pawns[1].eliminated).toBe(true);

    // Round 2: p2 shoves p0 over the bottom rim (fresh geometry via state).
    const state = g.getState();
    g.loadState({
      ...state,
      pawns: [
        // p0 drifted near the bottom after its own launch; put it back on the
        // crafted radial line as the victim.
        { ...state.pawns[0], position: { x: CX, y: CY + 240 }, velocity: { x: 0, y: 0 } },
        state.pawns[1], // eliminated ghost, parked outside
        { ...state.pawns[2], position: { x: CX, y: CY + 195 }, velocity: { x: 0, y: 0 } },
      ],
      round: { settleTicks: 0 },
      phase: "aiming",
      winnerId: null,
    });
    chooseOutward(g, "p2", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);

    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p2");
    expect(s.pawns.map((p) => p.eliminated)).toEqual([true, true, false]);
    g.destroy();
  });
});

describe("no survivor", () => {
  it("[16] finishes with a null winner when everybody leaves the arena", () => {
    const g = createGame();
    // Two pawns already past the rim pass-over zone, flying outward fast:
    // both cross the elimination boundary on the same ticks.
    g.loadState({
      phase: "moving",
      winnerId: null,
      round: { settleTicks: 0 },
      pawns: [
        pawnAt("p0", CX, CY - 250, { velocity: { x: 0, y: -3 } }),
        pawnAt("p1", CX, CY + 250, { velocity: { x: 0, y: 3 } }),
      ],
    });
    pump(g, 200);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBeNull();
    expect(s.pawns.every((p) => p.eliminated)).toBe(true);
    g.destroy();
  });
});

describe("single-pawn matches never auto-finish", () => {
  it("[19] keeps playing round after round while the pawn survives (solo flow)", () => {
    const g = createGame();
    for (let i = 0; i < 3; i++) {
      chooseInward(g, "p0", 2);
      // Single pawn: confirming completes the set → immediate movement,
      // exactly the classic solo flow (no deadline needed).
      expect(g.getState().phase).toBe("moving");
      pump(g);
      expect(g.getState().phase).toBe("aiming");
      expect(g.getState().winnerId).toBeNull();
    }
    g.destroy();
  });

  it("[19] still ends (with no winner) when the lone pawn flies out", () => {
    const g = createGame();
    choose(g, "p0", { x: CX, y: CY - 400 }, 5);
    expect(g.getState().phase).toBe("moving"); // solo: immediate
    pump(g);
    expect(g.getState().phase).toBe("finished");
    expect(g.getState().winnerId).toBeNull();
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// The finished phase
// ────────────────────────────────────────────────────────────────────────

describe("the finished phase", () => {
  function finishedMatch(): GameHandle {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);
    expect(g.getState().phase).toBe("finished");
    return g;
  }

  it("rejects every action command with wrong-phase (winner stays put)", () => {
    const g = finishedMatch();
    const winnerBefore = g.getState().winnerId;
    for (const cmd of [
      { type: "aim", playerId: "p0", x: CX, y: CY },
      { type: "setPower", playerId: "p0", power: 1 },
      { type: "confirmLaunch", playerId: "p0" },
      { type: "aim", playerId: "p1", x: CX, y: CY }, // eliminated player
    ] as const) {
      expect(g.applyCommand(cmd)).toEqual({ ok: false, reason: "wrong-phase" });
    }
    expect(g.getState().winnerId).toBe(winnerBefore);
    g.destroy();
  });

  it("rejects resolveRound once finished", () => {
    const g = finishedMatch();
    expect(g.applyCommand({ type: "resolveRound" })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    g.destroy();
  });

  it("ignores updates once finished", () => {
    const g = finishedMatch();
    const before = g.getState();
    for (let i = 0; i < 120; i++) g.update(DT);
    expect(g.getState()).toEqual(before);
    g.destroy();
  });

  it("resets the whole roster from a finished match", () => {
    const g = finishedMatch();
    g.dispatch({ type: "reset" });
    const s = g.getState();
    expect(s.phase).toBe("aiming");
    expect(s.winnerId).toBeNull();
    expect(s.pawns).toHaveLength(2);
    for (const p of s.pawns) {
      expect(p.eliminated).toBe(false);
      expect(p.confirmed).toBe(false);
      expect(p.power).toBe(CONFIG.power.default);
      expect(p.aim.active).toBe(false);
      expect(p.velocity).toEqual({ x: 0, y: 0 });
      // back at each pawn's own spawn (the crafted positions)
      expect(p.position).toEqual({ x: p.spawnX, y: p.spawnY });
    }
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// loadState normalization
// ────────────────────────────────────────────────────────────────────────

describe("loadState normalization (state-driven match rules)", () => {
  it("finishes with no winner when no pawn is active", () => {
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY - 300, { eliminated: true }),
      ])
    );
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBeNull();
    g.destroy();
  });

  it("finishes with the survivor when one pawn is active in a multi-pawn roster", () => {
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY),
        pawnAt("p1", CX, CY - 300, { eliminated: true }),
      ])
    );
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p0");
    g.destroy();
  });

  it("begins the round when every alive pawn arrives already confirmed", () => {
    // A fully-confirmed aiming state is transient by construction — the
    // engine resolves it exactly like live play would have.
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY - 100, { confirmed: true }),
        pawnAt("p1", CX, CY + 100, { confirmed: true, power: 2 }),
      ])
    );
    expect(g.getState().phase).toBe("moving");
    pump(g);
    expect(g.getState().phase).toBe("aiming"); // resolved and settled
    g.destroy();
  });

  it("keeps a single-pawn roster playing (no auto-finish)", () => {
    const g = createGame();
    g.loadState(matchState([pawnAt("p0", CX, CY)]));
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().winnerId).toBeNull();
    g.destroy();
  });

  it("preserves an explicitly finished state with its winner", () => {
    const g = createGame();
    g.loadState({
      phase: "finished",
      winnerId: "p1",
      round: { settleTicks: 0 },
      pawns: [
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY),
      ],
    });
    expect(g.getState().phase).toBe("finished");
    expect(g.getState().winnerId).toBe("p1");
    g.destroy();
  });

  it("restores ghosts as non-collidable on reconstruction", () => {
    // One eliminated pawn + two active: the ghost must not block anything.
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY),
        pawnAt("p1", CX, CY, { eliminated: true }),
        pawnAt("p2", CX, CY - 100, { colorIndex: 2 }),
      ])
    );
    expect(g.getState().pawns[1].eliminated).toBe(true);
    expect(g.getState().phase).toBe("aiming");
    g.destroy();
  });

  it("lets a moving state with one survivor resolve at settle (as live play would)", () => {
    // Mid-flight: the mover is already out (a legal state — its flight can
    // still be resolving) and a single survivor keeps gliding. The match
    // must not finish instantly on load; it finishes when the survivor
    // settles, exactly like an uninterrupted simulation.
    const g = createGame();
    g.loadState({
      phase: "moving",
      winnerId: null,
      round: { settleTicks: 10 },
      pawns: [
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY + 150, { velocity: { x: 0, y: 0.8 } }),
      ],
    });
    expect(g.getState().phase).toBe("moving");
    pump(g, 900);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p1");
    g.destroy();
  });

  it("reconstructs a mid-flight state with an eliminated mover bit-identically", () => {
    // The eliminated mover's flight is still resolving — the round must end
    // exactly where the uninterrupted simulation would end it, and a fresh
    // aiming round opens for the survivors.
    const craft = (): GameState => ({
      phase: "moving",
      winnerId: null,
      round: { settleTicks: 12 },
      pawns: [
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY + 150, { velocity: { x: 0, y: 1.2 } }),
        pawnAt("p2", CX, CY - 240, { colorIndex: 2 }),
      ],
    });
    const a = createGame();
    a.loadState(craft());
    pump(a, 900);
    expect(a.getState().phase).toBe("aiming");
    expect(aliveIds(a.getState())).toEqual(["p1", "p2"]);
    expect(a.getState().pawns.every((p) => p.eliminated || !p.confirmed)).toBe(true);

    const b = createGame();
    b.loadState(deserializeGameState(serializeGameState(craft())));
    pump(b, 900);
    expect(b.getState()).toEqual(a.getState());
    a.destroy();
    b.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Serialization, determinism, replay
// ────────────────────────────────────────────────────────────────────────

describe("N-player serialization and determinism", () => {
  it("[18] round-trips a mid-match three-player state through JSON", () => {
    const g = createGame({ players: specs(3) });
    chooseInward(g, "p0", 3);
    chooseInward(g, "p1", 2);
    chooseInward(g, "p2", 2);
    g.update(DT);
    g.update(DT);
    const restored = deserializeGameState(serializeGameState(g.getState()));
    expect(restored).toEqual(g.getState());
    g.destroy();
  });

  it("[18] round-trips a finished state with per-pawn flags and the winner", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);
    const original = g.getState();
    const restored = deserializeGameState(serializeGameState(original));
    expect(restored).toEqual(original);
    expect(restored.phase).toBe("finished");
    expect(restored.winnerId).toBe("p0");
    expect(restored.pawns[1].eliminated).toBe(true);
    g.destroy();
  });

  it("[18] continues deterministically after an elimination (state transfer)", () => {
    // p0 has just knocked p1 out; the match continues with p0 + p2.
    const build = () => {
      const g = createGame();
      const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
      g.loadState(knockoutSetup("p0", "p1", [bystander]));
      chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
      deadlineResolve(g);
      pump(g);
      return g;
    };
    const a = build();
    const b = createGame();
    b.loadState(deserializeGameState(serializeGameState(a.getState())));

    // Both continue through two more full simultaneous rounds.
    for (const g of [a, b]) {
      chooseInward(g, "p2", 2);
      chooseInward(g, "p0", 3);
      pump(g);
      chooseInward(g, "p0", 3);
      chooseInward(g, "p2", 2);
      pump(g);
    }
    expect(b.getState()).toEqual(a.getState());
    expect(b.snapshot()).toEqual(a.snapshot());
    a.destroy();
    b.destroy();
  });

  it("[18] replays a whole scripted match bit-identically (2 players)", () => {
    const engines = [createGame(), createGame()];
    const states = engines.map((g) => {
      g.loadState(knockoutSetup("p0", "p1"));
      chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
      deadlineResolve(g);
      pump(g);
      return g.getState();
    });
    expect(states[1]).toEqual(states[0]);
    expect(states[0].phase).toBe("finished");
    expect(states[0].winnerId).toBe("p0");
    for (const e of engines) e.destroy();
  });

  it("[18] replays a whole scripted match bit-identically (3 players, elimination included)", () => {
    const script = (g: GameHandle) => {
      const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
      g.loadState(knockoutSetup("p0", "p1", [bystander]));
      chooseOutward(g, "p0", { x: 0, y: 1 }, 5); // p1 knocked out (deadline round)
      deadlineResolve(g);
      pump(g);
      chooseInward(g, "p2", 2); // full round: both survivors choose
      chooseInward(g, "p0", 1);
      pump(g);
      chooseInward(g, "p0", 1); // and again
      chooseInward(g, "p2", 2);
      pump(g);
      return g.getState();
    };
    const engines = [createGame(), createGame()];
    const [s1, s2] = engines.map(script);
    expect(s2).toEqual(s1);
    expect(s1.pawns[1].eliminated).toBe(true);
    expect(s1.phase).toBe("aiming");
    for (const e of engines) e.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Projection and the engine's lack of local identity
// ────────────────────────────────────────────────────────────────────────

describe("projection is caller-localized; the engine has no local player", () => {
  function threePlayerState(): GameState {
    const g = createGame({ players: specs(3) });
    chooseInward(g, "p0", 1);
    chooseInward(g, "p1", 1);
    chooseInward(g, "p2", 1);
    pump(g); // back to aiming, round 2
    return g.getState();
  }

  it("the engine's own snapshot is a pure spectator view", () => {
    const g = createGame({ players: specs(3) });
    const s = g.snapshot();
    expect(s.localPawnId).toBeNull();
    expect(s.pawns.every((p) => !p.isLocal)).toBe(true);
    // Spectator controls are neutral (no pawn to describe).
    expect(s.power).toBe(CONFIG.power.default);
    expect(s.aimDirection).toBeNull();
    expect(s.isAiming).toBe(false);
    g.destroy();
  });

  it("marks isLocal for exactly the caller's pawn, per caller", () => {
    const state = threePlayerState();
    for (const viewer of ["p0", "p1", "p2", null]) {
      const view = projectSnapshot(state, viewer);
      expect(view.localPawnId).toBe(viewer);
      for (const p of view.pawns) {
        expect(p.isLocal).toBe(p.id === viewer);
      }
    }
  });

  it("the winner does not depend on who is looking", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    chooseOutward(g, "p0", { x: 0, y: 1 }, 5);
    deadlineResolve(g);
    pump(g);
    const state = g.getState();
    expect(state.winnerId).toBe("p0");
    expect(g.snapshot().winnerId).toBe("p0"); // spectator
    expect(projectSnapshot(state, "p0").winnerId).toBe("p0"); // winner's view
    expect(projectSnapshot(state, "p1").winnerId).toBe("p0"); // loser's view
    g.destroy();
  });

  it("projections agree on the authoritative facts and differ only on local controls", () => {
    const g = createGame({ players: specs(2) });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    const state = g.getState();
    const asP0 = projectSnapshot(state, "p0");
    const asP1 = projectSnapshot(state, "p1");
    // Same authoritative facts…
    expect(asP0.pawns.map((p) => p.eliminated)).toEqual(asP1.pawns.map((p) => p.eliminated));
    expect(asP0.phase).toBe(asP1.phase);
    expect(asP0.winnerId).toBe(asP1.winnerId);
    expect(asP0.pawns.map((p) => p.confirmed)).toEqual(asP1.pawns.map((p) => p.confirmed));
    // …but each viewer's controls describe their OWN pawn.
    expect(asP0.power).toBe(5);
    expect(asP1.power).toBe(CONFIG.power.default);
    expect(asP0.isAiming).toBe(true);
    expect(asP1.isAiming).toBe(false);
    g.destroy();
  });
});

describe("a server can run the whole match without any local identity", () => {
  it("drives a match using only commands, updates and authoritative state", () => {
    // Exactly the flow the authoritative server uses: no snapshot, no
    // projection, no local pawn id — applyCommand / update / getState /
    // serializeGameState only (resolveRound stands in for the deadline).
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + 400 });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    g.applyCommand({ type: "resolveRound" });
    while (g.getState().phase === "moving") g.update(DT);

    const wire = serializeGameState(g.getState());
    const final = deserializeGameState(wire);
    expect(final.phase).toBe("finished");
    expect(final.winnerId).toBe("p0");
    expect(final.pawns[1].eliminated).toBe(true);
    // Nothing client-ish ever enters the authoritative state.
    expect(wire).not.toMatch(/local/i);
    expect(wire).not.toMatch(/client/i);
    g.destroy();
  });
});
