import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  createGame,
  deserializeGameState,
  validateGameState,
  serializeGameState,
  type GameCommand,
  type GameHandle,
  type GameState,
  type PlayerSpec,
} from "../../game";
import { createGameHost, type GameHost } from "../index";

/**
 * Behavior suite for the headless authoritative game host.
 *
 * Everything here drives the match ONLY through the public host interface
 * (submitCommand + tick / the automatic loop) — exactly the call pattern a
 * future WebSocket transport will use. The engine's own behavior (physics,
 * turn rules, elimination) is pinned by src/game/__tests__; these tests pin
 * the HOSTING layer: lifecycle, fixed-timestep timing, the command trust
 * boundary, snapshot exposure and replayability.
 */

const DT = CONFIG.simulation.fixedTimestepMs; // 1000/60 — the one true tick
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── helpers ───────────────────────────────────────────────────────────────

/** Player specs p0..pN-1, mirroring the engine test helper. */
function specs(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i + 1}`,
  }));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every host created through this is destroyed after the test (no dangling timers). */
const liveHosts: GameHost[] = [];
function host(options: { players: PlayerSpec[]; clock?: () => number; maxCatchUpTicks?: number }): GameHost {
  const h = createGameHost(options);
  liveHosts.push(h);
  return h;
}
afterEach(() => {
  for (const h of liveHosts) h.destroy();
  liveHosts.length = 0;
});

/** The host's wire snapshot, parsed back through the engine boundary. */
function stateOf(h: GameHost): GameState {
  return deserializeGameState(h.serializedState());
}

/** Tick until the phase leaves "moving" (mirrors the engine tests' pump). */
function pumpTicks(h: GameHost, max = 700): number {
  let n = 0;
  while (stateOf(h).phase === "moving" && n < max) {
    h.tick();
    n += 1;
  }
  return n;
}

/**
 * Launch a pawn straight over the rim it is heading for (radially outward).
 * From the natural spawn ring (just inside the floor edge) a power-5 launch
 * flies over the rim and eliminates the launcher — the documented
 * self-knockout mechanic, used here as a deterministic way to finish
 * matches through commands only. The round then resolves at the DEADLINE
 * (the server-only resolveRound command), exactly like a real match whose
 * other players stayed silent.
 */
function selfEliminate(h: GameHost, playerId: string): void {
  const me = stateOf(h).pawns.find((p) => p.id === playerId);
  if (!me) throw new Error(`no pawn ${playerId}`);
  const dx = me.position.x - CX || 1;
  const dy = me.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  h.submitCommand({ type: "aim", playerId, x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 });
  h.submitCommand({ type: "setPower", playerId, power: 5 });
  h.submitCommand({ type: "confirmLaunch", playerId });
  h.submitCommand({ type: "resolveRound" }); // the decision deadline
}

/** A safe inward launch (mirrors the engine tests' launchInward). */
function launchInward(h: GameHost, playerId: string, power = 2): void {
  h.submitCommand({ type: "aim", playerId, x: CX, y: CY });
  h.submitCommand({ type: "setPower", playerId, power });
  h.submitCommand({ type: "confirmLaunch", playerId });
}

/** A fresh raw engine replica with the same roster (for equivalence checks). */
function replica(players: PlayerSpec[]): GameHandle {
  return createGame({ players });
}

/** Apply the same launch commands to a raw engine replica. */
function replicaInward(g: GameHandle, playerId: string, power = 2): void {
  g.applyCommand({ type: "aim", playerId, x: CX, y: CY });
  g.applyCommand({ type: "setPower", playerId, power });
  g.applyCommand({ type: "confirmLaunch", playerId });
}

// ────────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────────

describe("host lifecycle", () => {
  it("exposes exactly the intended transport-neutral API", () => {
    const h = host({ players: specs(2) });
    // The whole surface a future transport gets. submitCommand is the ONLY
    // mutator besides tick/start/stop — there is no state-loading path.
    expect(Object.keys(h).sort()).toEqual([
      "destroy",
      "isRunning",
      "onStateChange",
      "serializedState",
      "start",
      "stop",
      "submitCommand",
      "tick",
      "tickCount",
    ]);
  });

  it("creates a match from a supplied roster", () => {
    const h = host({ players: specs(3) });
    const s = stateOf(h);
    expect(validateGameState(s)).toBe(s); // the wire snapshot round-trips
    expect(s.phase).toBe("aiming");
    expect(s.winnerId).toBeNull();
    expect(s.pawns.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
    expect(s.pawns.map((p) => p.name)).toEqual(["Player 1", "Player 2", "Player 3"]);
    expect(s.pawns.every((p) => !p.confirmed)).toBe(true); // nobody chose yet
    expect(s.round.settleTicks).toBe(0);
    expect(h.tickCount()).toBe(0);
    expect(h.isRunning()).toBe(false);
  });

  it("requires a non-empty roster", () => {
    expect(() => createGameHost({ players: [] })).toThrow();
    expect(() => createGameHost(undefined as never)).toThrow();
  });

  it("starts and stops cleanly", async () => {
    const h = host({ players: specs(2) });
    expect(h.isRunning()).toBe(false);

    h.start();
    expect(h.isRunning()).toBe(true);
    h.start(); // idempotent — no second interval
    expect(h.isRunning()).toBe(true);

    await sleep(250); // ~15 ticks at 60 Hz; generous CI bounds below
    const ticksWhileRunning = h.tickCount();
    expect(ticksWhileRunning).toBeGreaterThanOrEqual(8);
    expect(ticksWhileRunning).toBeLessThanOrEqual(40);

    h.stop();
    expect(h.isRunning()).toBe(false);
    h.stop(); // idempotent
    await sleep(120);
    expect(h.tickCount()).toBe(ticksWhileRunning); // the loop really stopped
  });

  it("keeps the match while stopped and resumes ticking on restart", async () => {
    const h = host({ players: specs(2) });
    h.start();
    await sleep(80);
    h.stop();

    // A stopped host is paused, not deaf: commands still validate and apply.
    expect(h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY })).toEqual({ ok: true });
    const frozen = h.tickCount();

    h.start();
    await sleep(120);
    expect(h.tickCount()).toBeGreaterThan(frozen);
  });

  it("destroys cleanly and fails fast on later use", async () => {
    const h = createGameHost({ players: specs(2) }); // NOT registered — destroyed here
    h.start();
    launchInward(h, "p0", 1);
    h.tick();
    const lastSnapshot = h.serializedState();
    const lastTicks = h.tickCount();

    h.destroy();
    h.destroy(); // idempotent
    expect(h.isRunning()).toBe(false);

    await sleep(120);
    expect(h.tickCount()).toBe(lastTicks); // no ticking after destroy

    // Read accessors stay valid (a transport may flush the last snapshot)…
    expect(h.serializedState()).toBe(lastSnapshot);
    expect(h.tickCount()).toBe(lastTicks);
    // …but the host must not simulate or accept commands anymore.
    expect(() => h.start()).toThrow(/destroyed/);
    expect(() => h.tick()).toThrow(/destroyed/);
    expect(() => h.submitCommand({ type: "reset" })).toThrow(/destroyed/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Fixed-timestep simulation
// ────────────────────────────────────────────────────────────────────────

describe("fixed-timestep simulation", () => {
  it("tick() advances exactly one fixed step — the host adds no simulation behavior", () => {
    const h = host({ players: specs(2) });
    const r = replica(specs(2));
    try {
      launchInward(h, "p0", 2);
      replicaInward(r, "p0", 2);

      for (let i = 0; i < 40; i++) {
        h.tick();
        r.update(DT);
      }
      expect(h.serializedState()).toBe(serializeGameState(r.getState()));

      // Finish the turn on both, tick-for-tick.
      let guard = 0;
      while (stateOf(h).phase === "moving" && guard < 700) {
        h.tick();
        r.update(DT);
        guard += 1;
      }
      expect(h.serializedState()).toBe(serializeGameState(r.getState()));
      expect(stateOf(h).phase).toBe("aiming");
    } finally {
      r.destroy();
    }
  });

  it("the automatic loop feeds only fixed ticks (no variable wall-clock dt)", async () => {
    const h = host({ players: specs(2) });
    const r = replica(specs(2));
    try {
      launchInward(h, "p0", 2);
      replicaInward(r, "p0", 2);

      h.start();
      await sleep(250); // real wall-clock jitter happens here
      h.stop();
      const n = h.tickCount();
      expect(n).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(40);

      // Whatever jitter the loop saw, the simulation must look exactly like
      // n fixed ticks — any variable dt would diverge the trajectory.
      for (let i = 0; i < n; i++) r.update(DT);
      expect(h.serializedState()).toBe(serializeGameState(r.getState()));
    } finally {
      r.destroy();
    }
  });

  it("catches up after a missed wakeup using fixed ticks only", async () => {
    let fakeNow = 1000;
    const h = host({ players: specs(2), clock: () => fakeNow });
    const r = replica(specs(2));
    try {
      launchInward(h, "p0", 2);
      replicaInward(r, "p0", 2);

      h.start();
      fakeNow += 5 * DT + 1; // five ticks' worth of wall time passed at once
      await sleep(100); // let the real interval fire (>= once)
      expect(h.tickCount()).toBe(5); // exactly the five due ticks, no more

      for (let i = 0; i < 5; i++) r.update(DT);
      expect(h.serializedState()).toBe(serializeGameState(r.getState()));
    } finally {
      h.stop();
      r.destroy();
    }
  });

  it("drops the backlog after a long stall instead of catching up in a spiral", async () => {
    let fakeNow = 1000;
    const h = host({ players: specs(2), clock: () => fakeNow, maxCatchUpTicks: 2 });
    h.start();
    fakeNow += 20 * DT; // a 333 ms "stall"
    await sleep(100);
    expect(h.tickCount()).toBe(2); // clamped to maxCatchUpTicks, rest dropped

    fakeNow += DT + 1; // normal cadence resumes
    await sleep(100);
    expect(h.tickCount()).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Commands — the server-side trust boundary
// ────────────────────────────────────────────────────────────────────────

describe("command handling", () => {
  it("applies valid commands and acknowledges them", () => {
    const h = host({ players: specs(2) });
    expect(h.submitCommand({ type: "aim", playerId: "p0", x: CX + 100, y: CY })).toEqual({ ok: true });
    expect(h.submitCommand({ type: "setPower", playerId: "p0", power: 4 })).toEqual({ ok: true });
    const s = stateOf(h);
    expect(s.pawns[0].aim.active).toBe(true);
    expect(s.pawns[0].power).toBe(4);
    expect(h.submitCommand({ type: "confirmLaunch", playerId: "p0" })).toEqual({ ok: true });
    expect(stateOf(h).pawns[0].confirmed).toBe(true); // choice locked…
    expect(stateOf(h).phase).toBe("aiming"); // …but the round waits for p1
    expect(h.submitCommand({ type: "resolveRound" })).toEqual({ ok: true }); // deadline
    expect(stateOf(h).phase).toBe("moving"); // now the round resolves
  });

  it("rejects commands from unknown player ids", () => {
    const h = host({ players: specs(2) });
    const before = h.serializedState();
    expect(
      h.submitCommand({ type: "aim", playerId: "eve", x: CX, y: CY })
    ).toEqual({ ok: false, reason: "unknown-player" });
    expect(
      h.submitCommand({ type: "confirmLaunch", playerId: "mallory" })
    ).toEqual({ ok: false, reason: "unknown-player" });
    expect(h.serializedState()).toBe(before); // nothing was applied
  });

  it("rejects an eliminated player's commands, and a confirmed player's changes (round model)", () => {
    const h = host({ players: specs(3) });

    // Rounds are simultaneous: p1 and p2 may act while p0 also acts — no
    // "out of turn" rejections anymore.
    expect(h.submitCommand({ type: "aim", playerId: "p1", x: CX, y: CY })).toEqual({ ok: true });
    expect(h.submitCommand({ type: "setPower", playerId: "p2", power: 3 })).toEqual({ ok: true });

    // p1 locks in its choice…
    expect(h.submitCommand({ type: "confirmLaunch", playerId: "p1" })).toEqual({ ok: true });
    // …and can no longer change it this round.
    expect(h.submitCommand({ type: "aim", playerId: "p1", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "already-confirmed",
    });
    expect(h.submitCommand({ type: "setPower", playerId: "p1", power: 1 })).toEqual({
      ok: false,
      reason: "already-confirmed",
    });
    expect(h.submitCommand({ type: "confirmLaunch", playerId: "p1" })).toEqual({
      ok: false,
      reason: "already-confirmed",
    });
    // p0, who has NOT confirmed, can still choose freely.
    expect(h.submitCommand({ type: "setPower", playerId: "p0", power: 5 })).toEqual({ ok: true });

    // p0 eliminates itself at the deadline; the match continues with p1 + p2.
    selfEliminate(h, "p0");
    pumpTicks(h);
    expect(stateOf(h).phase).toBe("aiming");
    expect(stateOf(h).pawns[0].eliminated).toBe(true);

    // The eliminated player can no longer act.
    expect(h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
  });

  it("rejects malformed commands safely — the server never crashes", () => {
    const h = host({ players: specs(2) });
    const hostileProxy = new Proxy(
      { type: "aim", playerId: "p0", x: 1, y: 1 },
      {
        get() {
          throw new Error("boom");
        },
      }
    );
    const throwingType = {
      get type() {
        throw new Error("boom");
      },
    };

    const junk: unknown[] = [
      null,
      undefined,
      42,
      "aim",
      true,
      [],
      [1, 2, 3],
      {},
      { type: "aim" },
      { type: "aim", playerId: "p0" },
      { type: "aim", playerId: 123, x: 1, y: 1 },
      { type: "aim", playerId: "p0", x: "1", y: 1 },
      { type: "aim", playerId: "p0", x: NaN, y: 1 },
      { type: "aim", playerId: "p0", x: 1, y: Infinity },
      { type: "setPower", playerId: "p0", power: "3" },
      { type: "setPower", playerId: "p0" },
      { type: "confirmLaunch", playerId: 1 },
      { type: "teleport", playerId: "p0", x: 1, y: 1 },
      { type: "setPosition", playerId: "p0", position: { x: 0, y: 0 } },
      hostileProxy,
      throwingType,
    ];
    for (const bad of junk) {
      expect(h.submitCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }

    // The host is unharmed: a valid command applies and the loop still ticks.
    expect(h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY })).toEqual({ ok: true });
    h.tick();
    expect(h.tickCount()).toBe(1);
  });

  it("never trusts client state — state payloads are just malformed commands", () => {
    const h = host({ players: specs(2) });
    const before = h.serializedState();

    // A client "installs" a full authoritative state (object and string form).
    expect(h.submitCommand(JSON.parse(before))).toEqual({ ok: false, reason: "invalid-command" });
    expect(h.submitCommand(before)).toEqual({ ok: false, reason: "invalid-command" });
    expect(h.submitCommand({ type: "loadState", state: JSON.parse(before) })).toEqual({
      ok: false,
      reason: "invalid-command",
    });

    expect(h.serializedState()).toBe(before); // untouched
  });

  it("state changes only through commands and ticks", () => {
    const h = host({ players: specs(2) });
    const initial = h.serializedState();

    for (let i = 0; i < 150; i++) h.tick(); // aiming phase: ticks are no-ops
    expect(h.serializedState()).toBe(initial);

    h.submitCommand(null);
    h.submitCommand({ type: "eliminate", playerId: "p1" }); // outcome forgery
    expect(h.serializedState()).toBe(initial);

    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY }); // real intent
    expect(h.serializedState()).not.toBe(initial);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Snapshot exposure — the broadcast hook for a future transport
// ────────────────────────────────────────────────────────────────────────

describe("serialized state exposure", () => {
  it("pushes the current snapshot immediately and on every change", () => {
    const h = host({ players: specs(2) });
    const received: string[] = [];
    const unsubscribe = h.onStateChange((s) => received.push(s));

    expect(received).toEqual([h.serializedState()]); // immediate current state

    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    expect(received).toHaveLength(2);

    h.submitCommand({ type: "setPower", playerId: "p0", power: 3 });
    expect(received).toHaveLength(3);

    // Aiming-phase ticks emit nothing (no state change, no broadcast churn).
    h.tick();
    h.tick();
    expect(received).toHaveLength(3);

    h.submitCommand({ type: "confirmLaunch", playerId: "p0" });
    expect(received).toHaveLength(4);
    expect(received[3]).toBe(h.serializedState()); // always the latest

    unsubscribe();
    h.submitCommand({ type: "reset" });
    expect(received).toHaveLength(4); // no pushes after unsubscribe
  });

  it("supports several independent subscribers", () => {
    const h = host({ players: specs(2) });
    const a: string[] = [];
    const b: string[] = [];
    const unA = h.onStateChange((s) => a.push(s));
    h.onStateChange((s) => b.push(s));
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    unA();
    h.submitCommand({ type: "reset" });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Whole matches through the host
// ────────────────────────────────────────────────────────────────────────

describe("matches through the host", () => {
  it("runs a full 2-player match to a winner", () => {
    const h = host({ players: specs(2) });
    selfEliminate(h, "p0");
    pumpTicks(h);
    const s = stateOf(h);
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p1"); // last pawn standing
    expect(s.pawns.map((p) => p.eliminated)).toEqual([true, false]);
  });

  it("runs a full 3-player match over simultaneous rounds to a winner", () => {
    const h = host({ players: specs(3) });

    selfEliminate(h, "p0");
    pumpTicks(h);
    let s = stateOf(h);
    expect(s.phase).toBe("aiming"); // match continues, two survivors
    expect(s.pawns.filter((p) => !p.eliminated).map((p) => p.id)).toEqual(["p1", "p2"]);

    selfEliminate(h, "p1");
    pumpTicks(h);
    s = stateOf(h);
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p2");
    expect(s.pawns.map((p) => p.eliminated)).toEqual([true, true, false]);
  });

  it("runs a full 4-player match", () => {
    const h = host({ players: specs(4) });
    selfEliminate(h, "p0");
    pumpTicks(h);
    selfEliminate(h, "p1");
    pumpTicks(h);
    selfEliminate(h, "p2");
    pumpTicks(h);
    const s = stateOf(h);
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p3");
  });

  it("reset restores the match bit-identically from any point", () => {
    const h = host({ players: specs(2) });
    const initial = h.serializedState();

    // Reset mid-match (aiming, some commands already applied).
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 2 });
    expect(h.submitCommand({ type: "reset" })).toEqual({ ok: true });
    expect(h.serializedState()).toBe(initial);

    // Reset from a finished match.
    selfEliminate(h, "p0");
    pumpTicks(h);
    expect(stateOf(h).phase).toBe("finished");
    expect(h.submitCommand({ type: "reset" })).toEqual({ ok: true });
    expect(h.serializedState()).toBe(initial);
    expect(h.tickCount()).toBeGreaterThan(0); // ticks happened; state is pristine
  });

  it("replays deterministically from the command log (host and raw engine)", () => {
    // Run a 3-player match on the host, recording every command with the
    // tick index at which it was submitted — the persistence format a real
    // server would keep.
    const log: Array<{ tick: number; command: unknown }> = [];
    const record = (h: GameHost, command: unknown) => {
      log.push({ tick: h.tickCount(), command });
      expect(h.submitCommand(command)).toEqual({ ok: true });
    };

    const h = host({ players: specs(3) });
    const scriptedTurn = (h2: GameHost, playerId: string) => {
      const me = stateOf(h2).pawns.find((p) => p.id === playerId)!;
      const dx = me.position.x - CX || 1;
      const dy = me.position.y - CY;
      const len = Math.hypot(dx, dy) || 1;
      record(h2, { type: "aim", playerId, x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 });
      record(h2, { type: "setPower", playerId, power: 5 });
      record(h2, { type: "confirmLaunch", playerId });
      record(h2, { type: "resolveRound" }); // the decision deadline
      pumpTicks(h2);
    };
    scriptedTurn(h, "p0"); // p0 eliminates itself
    scriptedTurn(h, "p1"); // p1 eliminates itself → p2 wins
    const finalState = h.serializedState();
    expect(stateOf(h).phase).toBe("finished");
    expect(stateOf(h).winnerId).toBe("p2");
    const totalTicks = h.tickCount();

    // Replay on a fresh HOST purely from the log (no state ever shipped).
    const replayHost = host({ players: specs(3) });
    let next = 0;
    for (let t = 0; t < totalTicks; t++) {
      while (next < log.length && log[next].tick === t) {
        expect(replayHost.submitCommand(log[next].command)).toEqual({ ok: true });
        next += 1;
      }
      replayHost.tick();
    }
    while (next < log.length) {
      expect(replayHost.submitCommand(log[next].command)).toEqual({ ok: true });
      next += 1;
    }
    expect(replayHost.serializedState()).toBe(finalState);

    // Replay on a RAW ENGINE with the same fixed ticks — proving the host
    // layer adds zero simulation behavior end-to-end.
    const engine = replica(specs(3));
    try {
      next = 0;
      for (let t = 0; t < totalTicks; t++) {
        while (next < log.length && log[next].tick === t) {
          expect(engine.applyCommand(log[next].command as GameCommand)).toEqual({ ok: true });
          next += 1;
        }
        engine.update(DT);
      }
      while (next < log.length) {
        expect(engine.applyCommand(log[next].command as GameCommand)).toEqual({ ok: true });
        next += 1;
      }
      expect(serializeGameState(engine.getState())).toBe(finalState);
    } finally {
      engine.destroy();
    }
  });
});
