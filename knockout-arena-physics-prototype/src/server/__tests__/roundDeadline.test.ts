import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  type GameState,
  type PlayerSpec,
} from "../../game";
import {
  createGameHost,
  createGameServer,
  DEFAULT_ROUND_DECISION_TIMEOUT_MS,
  type GameHost,
  type GameServer,
  type Session,
} from "../index";

/**
 * The round decision deadline — the one piece of orchestration policy the
 * GameHost owns on top of the engine: while a match is in the "aiming"
 * phase, a wall-clock deadline is armed; when it expires the server itself
 * resolves the round through the privileged resolveRound command (confirmed
 * players move, unconfirmed players do not). All gameplay rules stay in the
 * engine; physics keeps its fixed 60 Hz timestep; wall-clock time never
 * enters the simulation.
 *
 * Rules pinned here (labels refer to the task spec):
 *  A  the default deadline is 10 000 ms
 *  B  roundDecisionTimeoutMs is configurable (host / room / server)
 *  C  starting a match arms exactly ONE deadline per aiming round
 *  D  a waiting room arms no deadline (no host exists before startMatch)
 *  E  the deadline fires at/after the configured time (manual + loop ticks)
 *  F  it never fires before the configured time
 *  G  all ELIGIBLE alive players confirmed → immediate resolution (the
 *     engine's eligibility: an eliminated player never holds a round open)
 *  H  early resolution cancels the deadline
 *  I  a cancelled deadline can never resolve anything later
 *  J  timeout resolution moves NO unconfirmed pawn
 *  K  timeout resolution still executes confirmed moves
 *  L  a disconnected player never blocks or resets the deadline (pinned
 *     with a LATE drop, so a reset bug would miss the assertion window)
 *  M  a disconnected player's pre-drop confirmed move still executes
 *  N  a disconnected unconfirmed player does not move at the deadline
 *  O  reconnect does not reset the deadline (no fresh window)
 *  P  reconnect before the deadline may still confirm (and finish the set)
 *  Q  reconnect after the deadline sees the post-resolution state
 *  R  a spent deadline can never resolve a NEWER round
 *  S  reset starts a fresh match with a fresh deadline (host level AND the
 *     privileged resetMatch facade)
 *  T  a finished match has no armed deadline; no future timeout mutates it
 *  U  destroy() tears the deadline down with the host — room destruction,
 *     server destruction and direct host destruction all leave no timer
 *  V  timeout/confirm races resolve the round exactly once (any order)
 *  W  no deadline is armed while the round is moving
 *  X  no deadline is armed once the match is finished
 *  Y  solo play is unaffected: SoloGame never touches a GameHost — pinned
 *     by app.test.tsx (local engine, zero network) and the client-boundary
 *     guard (no server imports in client source).
 *
 * Host-level tests drive everything with a FAKE clock and manual ticks —
 * the deadline is checked inside tick(), so the fireAt−1 / fireAt
 * boundaries are exact and no real waiting is needed. Room-level tests run
 * the real 60 Hz loop with short deadlines (real time, generous slack).
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── shared helpers ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Player specs p0..pN-1, mirroring the engine test helper. */
function specs(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i + 1}`,
  }));
}

const liveHosts: GameHost[] = [];
function host(
  options: {
    players: PlayerSpec[];
    clock?: () => number;
    maxCatchUpTicks?: number;
    roundDecisionTimeoutMs?: number;
  }
): GameHost {
  const h = createGameHost(options);
  liveHosts.push(h);
  return h;
}

const liveServers: GameServer[] = [];
function newServer(options?: {
  roundDecisionTimeoutMs?: number;
  reconnectReservationMs?: number;
}): GameServer {
  const server = createGameServer(options);
  liveServers.push(server);
  return server;
}

afterEach(() => {
  for (const h of liveHosts) h.destroy();
  liveHosts.length = 0;
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

/** The host's wire snapshot, parsed back through the engine boundary. */
function stateOf(h: GameHost): GameState {
  return deserializeGameState(h.serializedState());
}

/**
 * Counts aiming → moving transitions (exactly one per round resolution).
 * The host pushes on every state change, so the phase sequence is complete.
 */
function resolutionCounter(h: GameHost): () => number {
  const phases: GameState["phase"][] = [];
  h.onStateChange((serialized) => {
    phases.push(deserializeGameState(serialized).phase);
  });
  return () => {
    let n = 0;
    for (let i = 1; i < phases.length; i++) {
      if (phases[i - 1] === "aiming" && phases[i] === "moving") n += 1;
    }
    return n;
  };
}

/** A safe inward launch for one player (host-level: explicit playerId). */
function launchInward(h: GameHost, playerId: string, power = 2): void {
  h.submitCommand({ type: "aim", playerId, x: CX, y: CY });
  h.submitCommand({ type: "setPower", playerId, power });
  h.submitCommand({ type: "confirmLaunch", playerId });
}

/**
 * Aim straight over the rim and confirm — the deterministic self-knockout.
 * WITHOUT a manual resolveRound: the DEADLINE is what resolves the round.
 */
function aimOutwardAndConfirm(h: GameHost, playerId: string): void {
  const me = stateOf(h).pawns.find((p) => p.id === playerId);
  if (!me) throw new Error(`no pawn ${playerId}`);
  const dx = me.position.x - CX || 1;
  const dy = me.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  h.submitCommand({ type: "aim", playerId, x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 });
  h.submitCommand({ type: "setPower", playerId, power: 5 });
  h.submitCommand({ type: "confirmLaunch", playerId });
}

/** Pump manual fixed ticks until the phase leaves "moving" (or give up). */
function pumpUntilSettled(h: GameHost, max = 2000): void {
  let n = 0;
  while (stateOf(h).phase === "moving" && n < max) {
    h.tick();
    n += 1;
  }
}

// ── room-level helpers (real 60 Hz loop, real time) ───────────────────────

/** A waiting room with n seated sessions; returns their credentials. */
function makeRoom(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[]; tokens: string[] } {
  const sessions: Session[] = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  sessions.push(creator);
  tokens.push(created.reconnectToken);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, roomId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error("unreachable");
    sessions.push(s);
    tokens.push(joined.reconnectToken);
  }
  return { roomId, sessions, tokens };
}

/** One pushed state, tagged with its wall-clock arrival time. */
interface PhaseEvent {
  phase: GameState["phase"];
  at: number;
  state: GameState;
}

/** Captures (phase, state, timestamp) for every state push to one session. */
function phaseEvents(server: GameServer, session: Session): PhaseEvent[] {
  const events: PhaseEvent[] = [];
  server.onRoomState(session, (serialized) => {
    events.push({ phase: deserializeGameState(serialized).phase, at: Date.now(), state: deserializeGameState(serialized) });
  });
  return events;
}

/** Wall-clock times of every aiming → moving transition (round resolution). */
function resolutionTimes(events: PhaseEvent[]): number[] {
  const times: number[] = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i - 1].phase === "aiming" && events[i].phase === "moving") {
      times.push(events[i].at);
    }
  }
  return times;
}

/** Poll until the predicate holds (real-time match progression). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

/** A safe inward launch for one seated session (facade stamps ownership). */
function launchInwardSession(server: GameServer, session: Session, power = 2): void {
  server.submitCommand(session, { type: "aim", x: CX, y: CY });
  server.submitCommand(session, { type: "setPower", power });
  server.submitCommand(session, { type: "confirmLaunch" });
}

// ────────────────────────────────────────────────────────────────────────
// Configuration — A, B
// ────────────────────────────────────────────────────────────────────────

describe("round decision deadline — configuration", () => {
  it("[A] defaults to a 10 000 ms round decision deadline", () => {
    expect(DEFAULT_ROUND_DECISION_TIMEOUT_MS).toBe(10_000);
    let fakeNow = 1_000;
    const h = host({ players: specs(2), clock: () => fakeNow });
    // Round 1's deadline is armed the moment the aiming phase exists
    // (host creation — startMatch creates and starts the host at once).
    expect(h.roundDeadline()).toBe(1_000 + 10_000);
  });

  it("[B] accepts a custom roundDecisionTimeoutMs", () => {
    let fakeNow = 5_000;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 250,
    });
    expect(h.roundDeadline()).toBe(5_250);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Host behavior with a fake clock — C, E–K, R, S, T, V, W, X
// ────────────────────────────────────────────────────────────────────────

describe("round decision deadline — host behavior (fake clock, manual ticks)", () => {
  it("[C] arms exactly ONE deadline per aiming round — ticks and aim commands do not re-arm it", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const armedAt = h.roundDeadline();
    expect(armedAt).toBe(5_000);
    // Fixed ticks during aiming leave the SAME fireAt in place.
    for (let i = 0; i < 5; i++) {
      fakeNow += 100;
      h.tick();
      expect(h.roundDeadline()).toBe(armedAt);
    }
    // Non-phase commands (aim/power) do not re-arm it either.
    h.submitCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 2 });
    expect(h.roundDeadline()).toBe(armedAt);
  });

  it("[E/F] never fires before the deadline and fires exactly at it", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const resolutions = resolutionCounter(h);
    // One millisecond before: still aiming, still armed.
    fakeNow = 4_999;
    h.tick();
    expect(stateOf(h).phase).toBe("aiming");
    expect(h.roundDeadline()).toBe(5_000);
    expect(resolutions()).toBe(0);
    // At the deadline: resolved by the server, exactly once.
    fakeNow = 5_000;
    h.tick();
    expect(stateOf(h).phase).toBe("moving");
    expect(h.roundDeadline()).toBeNull(); // consumed
    expect(resolutions()).toBe(1);
  });

  it("[G/H/I] all-confirmed resolves early, cancels the deadline, and the spent deadline never fires again", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const resolutions = resolutionCounter(h);
    const originalFireAt = h.roundDeadline()!;
    expect(originalFireAt).toBe(5_000);

    fakeNow = 100; // long before the deadline
    launchInward(h, "p0");
    expect(stateOf(h).phase).toBe("aiming"); // one of two confirmed
    launchInward(h, "p1");
    expect(stateOf(h).phase).toBe("moving"); // [G] engine resolved immediately
    expect(resolutions()).toBe(1);
    expect(h.roundDeadline()).toBeNull(); // [H] cancelled on leaving aiming

    // [I] the ORIGINAL deadline is now deep in the past — advancing the
    // clock past it (and ticking) must not resolve anything again.
    fakeNow = originalFireAt + 1;
    h.tick();
    expect(stateOf(h).phase).toBe("moving"); // the same, single resolution
    expect(resolutions()).toBe(1);
  });

  it("[G] only ELIGIBLE (alive) players count — an eliminated player's absence never holds a round open", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(3),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const resolutions = resolutionCounter(h);

    // Round 1: p2 knocks itself out; p0 and p1 stay silent — the DEADLINE
    // resolves the round (a disconnected or silent player never blocks it).
    aimOutwardAndConfirm(h, "p2");
    fakeNow = 5_000;
    h.tick();
    expect(resolutions()).toBe(1);
    let guard = 0;
    while (stateOf(h).phase === "moving" && guard++ < 700) h.tick();
    expect(stateOf(h).phase).toBe("aiming"); // two survivors → the match goes on
    expect(stateOf(h).pawns.find((p) => p.id === "p2")!.eliminated).toBe(true);

    // Round 2: the TWO alive players confirm. The eliminated p2 is not
    // eligible, so the set is complete and the round resolves immediately —
    // long before this round's own deadline.
    const fireAt2 = h.roundDeadline()!;
    expect(fireAt2).toBeGreaterThan(5_000); // a fresh window for the new round
    fakeNow = 5_400;
    launchInward(h, "p0");
    launchInward(h, "p1");
    expect(stateOf(h).phase).toBe("moving"); // early, without p2
    expect(resolutions()).toBe(2);
    expect(h.roundDeadline()).toBeNull(); // the round-2 deadline was cancelled
  });

  it("[J] a timeout resolution moves NO unconfirmed pawn (and eliminates nobody)", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const spawn = stateOf(h).pawns.map((p) => ({ ...p.position }));
    // Nobody confirms — the deadline resolves the round empty.
    fakeNow = 5_000;
    h.tick();
    expect(stateOf(h).phase).toBe("moving");
    pumpUntilSettled(h);
    expect(stateOf(h).phase).toBe("aiming"); // a fresh round began
    const after = stateOf(h);
    expect(after.pawns.map((p) => ({ ...p.position }))).toEqual(spawn); // frozen
    expect(after.pawns.every((p) => !p.eliminated)).toBe(true); // a timeout is not an elimination
    expect(after.pawns.every((p) => !p.confirmed)).toBe(true); // fresh round
  });

  it("[K] a timeout resolution still executes confirmed moves", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const spawn = stateOf(h).pawns.map((p) => ({ ...p.position }));
    launchInward(h, "p0"); // only p0 locks a move in
    fakeNow = 5_000;
    h.tick(); // the deadline resolves: p0's move fires, p1's does not exist
    expect(stateOf(h).phase).toBe("moving");
    pumpUntilSettled(h);
    const after = stateOf(h);
    const p0 = after.pawns.find((p) => p.id === "p0")!;
    const p1 = after.pawns.find((p) => p.id === "p1")!;
    const p0Travelled = Math.hypot(p0.position.x - spawn[0].x, p0.position.y - spawn[0].y);
    expect(p0Travelled).toBeGreaterThan(1); // the confirmed move executed
    expect(p1.position).toEqual(spawn[1]); // the silent player never moved
    expect(p0.eliminated).toBe(false); // an inward power-2 launch survives
    expect(p1.eliminated).toBe(false);
  });

  it("[R] a spent deadline can never resolve a NEWER round — each round gets its own", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const resolutions = resolutionCounter(h);

    // Round 1 resolves BY the deadline (nobody confirmed).
    fakeNow = 5_000;
    h.tick();
    expect(resolutions()).toBe(1);
    // The empty round settles immediately; round 2 begins.
    pumpUntilSettled(h);
    expect(stateOf(h).phase).toBe("aiming");
    const round2FireAt = h.roundDeadline();
    expect(round2FireAt).not.toBeNull();
    expect(round2FireAt!).toBeGreaterThan(5_000); // a FRESH fireAt, not round 1's

    // Deep inside the window where round 1's spent fireAt already lies in
    // the past: ticks there must not resolve round 2.
    fakeNow = 5_500;
    h.tick();
    expect(stateOf(h).phase).toBe("aiming");
    expect(resolutions()).toBe(1);

    // Round 2 resolves only at ITS OWN deadline.
    fakeNow = round2FireAt!;
    h.tick();
    expect(stateOf(h).phase).toBe("moving");
    expect(resolutions()).toBe(2);
  });

  it("[S] reset starts a fresh match with a FRESH deadline — the old one cannot resolve it", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const resolutions = resolutionCounter(h);

    // Late in round 1's window, the server resets the match.
    fakeNow = 4_900;
    expect(h.submitCommand({ type: "reset" })).toEqual({ ok: true });
    expect(stateOf(h).phase).toBe("aiming");
    expect(h.roundDeadline()).toBe(4_900 + 5_000); // a full fresh window

    // Round 1's original fireAt (5 000) is now in the past of the NEW
    // match's window — advancing past it must not resolve the new round.
    fakeNow = 5_001;
    h.tick();
    expect(stateOf(h).phase).toBe("aiming");
    expect(resolutions()).toBe(0);

    // The new match resolves at its OWN deadline, not before.
    fakeNow = 9_900;
    h.tick();
    expect(stateOf(h).phase).toBe("moving");
    expect(resolutions()).toBe(1);
  });

  it("[T] a finished match keeps no armed deadline and no future timeout can mutate it", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    const resolutions = resolutionCounter(h);

    // p0 knocks itself out; p1 stays silent — the DEADLINE resolves it.
    aimOutwardAndConfirm(h, "p0");
    fakeNow = 5_000;
    h.tick();
    let guard = 0;
    while (stateOf(h).phase !== "finished" && guard++ < 700) h.tick();
    const finished = stateOf(h);
    expect(finished.phase).toBe("finished");
    expect(finished.winnerId).toBe("p1");
    expect(h.roundDeadline()).toBeNull(); // nothing is armed anymore

    // Long after every conceivable deadline: the match must not change.
    fakeNow = 55_000;
    for (let i = 0; i < 300; i++) h.tick();
    expect(resolutions()).toBe(1); // no extra resolution ever happened
    expect(stateOf(h).phase).toBe("finished");
    expect(stateOf(h).winnerId).toBe("p1");
  });

  it("[V] confirm racing the deadline resolves the round exactly once, in every order", () => {
    // (1) the full confirmation lands one instant BEFORE the deadline:
    //     early resolution wins and the deadline never fires.
    {
      let fakeNow = 0;
      const h = host({
        players: specs(2),
        clock: () => fakeNow,
        roundDecisionTimeoutMs: 5_000,
      });
      const resolutions = resolutionCounter(h);
      fakeNow = 4_999;
      launchInward(h, "p0");
      launchInward(h, "p1");
      expect(stateOf(h).phase).toBe("moving");
      fakeNow = 5_000; // the would-be deadline moment
      h.tick();
      expect(resolutions()).toBe(1);
    }
    // (2) the deadline fires first: a late confirm is wrong-phase rejected.
    {
      let fakeNow = 0;
      const h = host({
        players: specs(2),
        clock: () => fakeNow,
        roundDecisionTimeoutMs: 5_000,
      });
      const resolutions = resolutionCounter(h);
      fakeNow = 5_000;
      h.tick();
      expect(stateOf(h).phase).toBe("moving");
      const late = h.submitCommand({ type: "confirmLaunch", playerId: "p1" });
      expect(late.ok).toBe(false);
      expect(resolutions()).toBe(1);
    }
    // (3) the confirmation is processed AT the deadline instant, just
    //     before the tick: the early resolution wins, the tick is a no-op.
    {
      let fakeNow = 0;
      const h = host({
        players: specs(2),
        clock: () => fakeNow,
        roundDecisionTimeoutMs: 5_000,
      });
      const resolutions = resolutionCounter(h);
      fakeNow = 5_000;
      launchInward(h, "p0");
      launchInward(h, "p1"); // completes the set → resolution
      h.tick(); // phase is already "moving": no deadline left to fire
      expect(resolutions()).toBe(1);
      expect(stateOf(h).phase).toBe("moving");
    }
  });

  it("[W] no deadline is armed while the round is moving — and a fresh one arms for the next round", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    launchInward(h, "p0");
    launchInward(h, "p1"); // early resolution → moving
    expect(stateOf(h).phase).toBe("moving");
    expect(h.roundDeadline()).toBeNull();
    fakeNow += 60_000; // an hour of moving: nothing armed, nothing fires
    h.tick();
    expect(stateOf(h).phase).toBe("moving");
    pumpUntilSettled(h);
    expect(stateOf(h).phase).toBe("aiming");
    expect(h.roundDeadline()).toBe(fakeNow + 5_000); // fresh round, fresh deadline
  });

  it("[X] no deadline is armed once the match is finished", () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 5_000,
    });
    // Both players knock themselves out in the same round.
    aimOutwardAndConfirm(h, "p0");
    aimOutwardAndConfirm(h, "p1"); // everyone confirmed → immediate resolution
    let guard = 0;
    while (stateOf(h).phase !== "finished" && guard++ < 700) h.tick();
    expect(stateOf(h).phase).toBe("finished");
    expect(h.roundDeadline()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Host teardown — U
// ────────────────────────────────────────────────────────────────────────

describe("round decision deadline — teardown", () => {
  it("[U] destroy() clears the armed deadline and the loop can never fire again", async () => {
    let fakeNow = 0;
    const h = host({
      players: specs(2),
      clock: () => fakeNow,
      roundDecisionTimeoutMs: 50,
    });
    h.start(); // the real interval — but the clock never advances, so no
    // tick ever falls due and the deadline cannot fire without ticks.
    await sleep(80); // far past the 50 ms deadline in real time
    expect(h.tickCount()).toBe(0);
    expect(stateOf(h).phase).toBe("aiming"); // never resolved
    h.destroy();
    expect(h.roundDeadline()).toBeNull(); // the token is gone
    // Far past the destroyed deadline, still nothing: no timer survived.
    fakeNow = 1_000_000;
    await sleep(80);
    expect(stateOf(h).phase).toBe("aiming");
    expect(() => h.tick()).toThrow(); // the dead host rejects all driving
  });

  it("[U] destroying the game server tears down every room's armed deadline", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 60 });
    const { roomId } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    server.destroy(); // rooms, hosts, sessions, credentials — all gone
    expect(server.roomCount()).toBe(0);
    // Far past the configured deadline: no timer fires, nothing throws.
    await sleep(200);
    expect(server.roomCount()).toBe(0);
  });

  it("[U] destroying the ROOM mid-aiming tears its armed deadline down with it", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 60 });
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    // Mid-aiming, with the deadline armed, both players leave cleanly: the
    // last leave empties the room and destroys it (and its host) at once.
    expect(server.leaveRoom(sessions[0]).ok).toBe(true);
    expect(server.leaveRoom(sessions[1]).ok).toBe(true);
    expect(server.getRoom(roomId)).toBeNull();
    expect(server.roomCount()).toBe(0);
    // Far past the configured deadline: no timer fires and nothing throws —
    // a stale firing would submit to a destroyed host and crash the process.
    await sleep(250);
    expect(server.roomCount()).toBe(0);
    expect(server.getRoom(roomId)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Room level, real 60 Hz loop — C (cadence), D, E (loop-fired), L–Q
// ────────────────────────────────────────────────────────────────────────

describe("round decision deadline — room behavior (real loop, short deadlines)", () => {
  it("[C/E] startMatch arms exactly one deadline per round: a steady one-at-a-time cadence", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 200 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    const t0 = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => events.length > 0, 3000)).toBe(true);

    // Silent players: every round is resolved BY its deadline, through the
    // real 60 Hz loop (no manual resolveRound anywhere in this test).
    expect(await waitFor(() => resolutionTimes(events).length >= 3, 4000)).toBe(true);
    const times = resolutionTimes(events);
    expect(times.length).toBeGreaterThanOrEqual(3);
    // The first round was never resolved early…
    expect(times[0] - t0).toBeGreaterThanOrEqual(140); // ≈ 0.7 × 200 ms
    // …and no deadline ever fired twice for the same round: consecutive
    // resolutions are spaced by at least most of one timeout window.
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(140);
    }
    // Empty rounds settle immediately, so the cadence tracks the timeout.
    expect(times[times.length - 1] - t0).toBeLessThan(1500);
  }, 8000);

  it("[D] a waiting room arms no deadline — nothing resolves before startMatch", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 120 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    await sleep(350); // > 2× the configured deadline, with no match running
    expect(events).toHaveLength(0); // no host exists → no state, no timer
    expect(server.getRoom(roomId)!.state).toBe("waiting");
    // And starting afterwards behaves normally.
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => resolutionTimes(events).length >= 1, 2000)).toBe(true);
  }, 8000);

  it("[L] a disconnected, unconfirmed player does not block the deadline", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 250 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    const t0 = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    // p1's connection drops immediately and never comes back: p1 is alive
    // and unconfirmed — that must not hold the round hostage.
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    expect(
      await waitFor(() => resolutionTimes(events).length >= 1, 1500)
    ).toBe(true);
    const first = resolutionTimes(events)[0];
    expect(first - t0).toBeGreaterThanOrEqual(180); // not early (nobody confirmed)
    expect(first - t0).toBeLessThanOrEqual(800); // at the deadline, not blocked
  }, 8000);

  it("[L] a disconnect LATE in the window does not extend the deadline (a drop never resets it)", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 400 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    const t0 = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    // Nobody confirms. p1's connection drops 80 ms before the deadline: if
    // the drop had reset the timer, the round would resolve at ~t0+720 —
    // outside this window. It must resolve at the ORIGINAL deadline (~400).
    await sleep(320); // → ~t0+320 (the deadline sits at ~t0+400)
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    expect(
      await waitFor(() => resolutionTimes(events).length >= 1, 1500)
    ).toBe(true);
    const first = resolutionTimes(events)[0];
    expect(first - t0).toBeGreaterThanOrEqual(240); // not early (nobody confirmed)
    expect(first - t0).toBeLessThanOrEqual(650); // the ORIGINAL deadline, not a reset one
  }, 8000);

  it("[M] a disconnected player's pre-drop confirmed move still executes at the deadline", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 250 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => events.length > 0, 3000)).toBe(true);
    const spawn = events[0].state.pawns.map((p) => ({ ...p.position }));

    // p1 locks in an inward move, THEN drops; p0 stays silent.
    launchInwardSession(server, sessions[1]);
    expect(server.reserve(sessions[1])).toEqual({ ok: true });

    // The deadline (not anyone's confirm) resolves the round…
    expect(await waitFor(() => resolutionTimes(events).length >= 1, 1500)).toBe(true);
    // …and p1's confirmed move executes without p1 being connected.
    expect(
      await waitFor(
        () => events[events.length - 1].phase === "aiming", // settled
        8000
      )
    ).toBe(true);

    const room = server.getRoom(roomId)!;
    expect(room.seats).toEqual([
      { playerId: "p0", connected: true, displayName: null },
      { playerId: "p1", connected: false, displayName: null }, // still just disconnected
    ]);
    const latest = events[events.length - 1].state;
    const p0 = latest.pawns.find((p) => p.id === "p0")!;
    const p1 = latest.pawns.find((p) => p.id === "p1")!;
    // p1 moved (its pre-drop confirm fired); p0 never chose and never moved.
    expect(
      Math.hypot(p1.position.x - spawn[1].x, p1.position.y - spawn[1].y)
    ).toBeGreaterThan(1);
    expect(p0.position).toEqual(spawn[0]);
    expect(p0.eliminated).toBe(false);
    expect(p1.eliminated).toBe(false); // disconnecting is not elimination
  }, 15000);

  it("[N] a disconnected player without a confirmed move does not move at the deadline", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 250 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => events.length > 0, 3000)).toBe(true);
    const spawn = events[0].state.pawns.map((p) => ({ ...p.position }));

    // p0 locks in a move; p1 drops WITHOUT confirming.
    launchInwardSession(server, sessions[0]);
    expect(server.reserve(sessions[1])).toEqual({ ok: true });

    expect(await waitFor(() => resolutionTimes(events).length >= 1, 1500)).toBe(true);
    expect(
      await waitFor(() => events[events.length - 1].phase === "aiming", 8000)
    ).toBe(true);

    const latest = events[events.length - 1].state;
    const p0 = latest.pawns.find((p) => p.id === "p0")!;
    const p1 = latest.pawns.find((p) => p.id === "p1")!;
    expect(
      Math.hypot(p0.position.x - spawn[0].x, p0.position.y - spawn[0].y)
    ).toBeGreaterThan(1); // the connected player's move fired
    expect(p1.position).toEqual(spawn[1]); // the disconnected silent pawn froze
    expect(p1.eliminated).toBe(false); // and it was not auto-eliminated
    expect(server.getRoom(roomId)!.seats[1]).toEqual({
      playerId: "p1",
      connected: false,
      displayName: null,
    });
  }, 15000);

  it("[O] reconnecting mid-round does not reset the deadline", async () => {
    const server = newServer({
      roundDecisionTimeoutMs: 400,
      reconnectReservationMs: 10_000,
    });
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    const t0 = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    // Nobody confirms. p1 drops and reconnects 80 ms before the deadline.
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    await sleep(320); // → ~t0+320 (the deadline sits at ~t0+400)
    expect(server.reconnect(tokens[1]).ok).toBe(true);
    expect(server.getRoom(roomId)!.seats[1]).toEqual({
      playerId: "p1",
      connected: true,
      displayName: null,
    });

    // If reconnect had reset the deadline, the round would resolve at
    // ~t0+720 — after this window. It must resolve at the ORIGINAL one.
    expect(
      await waitFor(() => resolutionTimes(events).length >= 1, 1500)
    ).toBe(true);
    const first = resolutionTimes(events)[0];
    expect(first - t0).toBeGreaterThanOrEqual(240); // not early (nobody confirmed)
    expect(first - t0).toBeLessThanOrEqual(650); // the ORIGINAL deadline, not a reset one
  }, 8000);

  it("[P] a player who reconnects before the deadline may still confirm — and finish the set early", async () => {
    const server = newServer({
      roundDecisionTimeoutMs: 1_500,
      reconnectReservationMs: 10_000,
    });
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    const t0 = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);

    // p0 confirms alone — one confirm resolves nothing.
    launchInwardSession(server, sessions[0]);
    expect(await waitFor(() => events.length > 0, 3000)).toBe(true);
    expect(events[events.length - 1].phase).toBe("aiming");

    // p1 drops mid-round, then reconnects well before the deadline.
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    await sleep(400); // → ~t0+400 (the deadline sits at ~t0+1000)
    expect(server.reconnect(tokens[1]).ok).toBe(true);
    // The recovered p1 still chooses in the SAME round…
    launchInwardSession(server, sessions[1]);

    // …and completing the set resolves the round EARLY — before the
    // deadline and without any fresh window being granted.
    expect(
      await waitFor(() => resolutionTimes(events).length >= 1, 1500)
    ).toBe(true);
    const first = resolutionTimes(events)[0];
    expect(first - t0).toBeGreaterThanOrEqual(350); // after the reconnect confirm
    expect(first - t0).toBeLessThanOrEqual(1300); // well before the deadline (1500)
  }, 8000);

  it("[Q] a player who reconnects after the deadline observes the post-resolution state", async () => {
    const server = newServer({
      roundDecisionTimeoutMs: 200,
      reconnectReservationMs: 10_000,
    });
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => events.length > 0, 3000)).toBe(true);
    const spawn = events[0].state.pawns.map((p) => ({ ...p.position }));

    // Nobody confirms; p1 is gone while (at least) one deadline passes.
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    await sleep(700); // ≥ 2 empty rounds resolved and settled
    expect(resolutionTimes(events).length).toBeGreaterThanOrEqual(1);

    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.playerId).toBe("p1"); // same seat
    expect(server.getRoom(roomId)!.state).toBe("playing");

    // The reconnection lands in a LATER round than the one p1 left: a
    // fresh aiming phase, nothing confirmed, nothing moved.
    expect(
      await waitFor(
        () => events[events.length - 1].phase === "aiming",
        1000
      )
    ).toBe(true);
    const latest = events[events.length - 1].state;
    expect(latest.pawns.every((p) => !p.confirmed)).toBe(true);
    expect(latest.pawns.map((p) => ({ ...p.position }))).toEqual(spawn); // empty rounds moved nobody
    // And the recovered player is a full participant of the current round.
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: CX, y: CY })
    ).toEqual({ ok: true });
    expect(
      server.submitCommand(sessions[1], { type: "setPower", power: 2 })
    ).toEqual({ ok: true });
    expect(
      server.submitCommand(sessions[1], { type: "confirmLaunch" })
    ).toEqual({ ok: true });
  }, 8000);

  it("[S] a privileged reset through the facade gives the new match a fresh deadline — the old one cannot resolve it", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 400 });
    const { roomId, sessions } = makeRoom(server, 2);
    const events = phaseEvents(server, sessions[0]);
    const t0 = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    // The old deadline ≈ start + 400 (t0 is taken immediately before
    // startMatch; the +100 guard below absorbs measurement skew).
    const oldDeadline = t0 + 400;
    // Nobody confirms. Early in the window, the server resets the match
    // through the privileged facade path (the one a future rematch vote
    // would use) — comfortably before the old deadline could fire.
    await sleep(150);
    expect(server.resetMatch(roomId)).toEqual({ ok: true });
    expect(events[events.length - 1].phase).toBe("aiming"); // fresh match state
    expect(events[events.length - 1].state.pawns.every((p) => !p.confirmed)).toBe(true);

    // Wait deterministically until the OLD deadline moment has passed: the
    // new match's round must still be open — the spent deadline cannot
    // resolve it…
    expect(await waitFor(() => Date.now() > oldDeadline + 100, 3000)).toBe(true);
    expect(resolutionTimes(events)).toHaveLength(0);
    // …and the new match resolves at ITS OWN deadline (≈ reset + 400).
    expect(
      await waitFor(() => resolutionTimes(events).length >= 1, 3000)
    ).toBe(true);
    const first = resolutionTimes(events)[0];
    expect(first - t0).toBeGreaterThanOrEqual(500); // after the reset's fresh window began
  }, 10000);
});

// ────────────────────────────────────────────────────────────────────────
// Snapshot metadata for the client countdown — the deadline the server
// stamps on every viewer-projected snapshot (onRoomView). Presentation
// data only: clients may render a countdown from it, never act on it.
// ────────────────────────────────────────────────────────────────────────

/** One viewer-projected push, tagged with its arrival time. */
interface ViewEvent {
  phase: GameState["phase"];
  roundDeadline: number | null | undefined;
  at: number;
}

/** Captures (phase, stamped deadline, timestamp) for every view push. */
function viewEvents(server: GameServer, session: Session): ViewEvent[] {
  const events: ViewEvent[] = [];
  server.onRoomView(session, (view) => {
    events.push({ phase: view.phase, roundDeadline: view.roundDeadline, at: Date.now() });
  });
  return events;
}

describe("round decision deadline — snapshot metadata (onRoomView)", () => {
  it("stamps aiming views with the room's authoritative deadline; nothing is pushed while waiting", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 5_000 });
    const { roomId, sessions } = makeRoom(server, 2);
    const views = viewEvents(server, sessions[0]);
    await sleep(120); // waiting room: no host exists, no views at all
    expect(views).toHaveLength(0);
    const startAt = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(views.length).toBeGreaterThan(0); // the subscribe-time push is synchronous
    const first = views[0];
    expect(first.phase).toBe("aiming");
    expect(typeof first.roundDeadline).toBe("number");
    // An ABSOLUTE timestamp ~one full window ahead, in the server's clock.
    expect(first.roundDeadline as number).toBeGreaterThanOrEqual(startAt + 4_000);
    expect(first.roundDeadline as number).toBeLessThanOrEqual(startAt + 6_000);
    // Non-phase commands during the round re-push the SAME deadline.
    server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY });
    expect(views.length).toBeGreaterThan(1);
    expect(views[1].roundDeadline).toBe(first.roundDeadline);
  });

  it("a new round stamps a FRESH deadline; resolution (by deadline or early) clears the stamp", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 250 });
    const { roomId, sessions } = makeRoom(server, 2);
    const views = viewEvents(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(views.length).toBeGreaterThan(0);
    const round1Deadline = views[0].roundDeadline as number;

    // Round 1 resolves at the deadline: the moving view carries NO stamp.
    expect(await waitFor(() => views.some((v) => v.phase === "moving"), 1500)).toBe(true);
    expect(views.find((v) => v.phase === "moving")!.roundDeadline).toBeNull();

    // The empty round settles; round 2's aiming view carries a NEW, later one.
    expect(
      await waitFor(() => views.filter((v) => v.phase === "aiming").length >= 2, 1500)
    ).toBe(true);
    const round2Deadline = views.filter((v) => v.phase === "aiming")[1]
      .roundDeadline as number;
    expect(round2Deadline).toBeGreaterThan(round1Deadline);

    // Early resolution (everyone confirms): the moving view again carries none.
    launchInwardSession(server, sessions[0]);
    launchInwardSession(server, sessions[1]);
    expect(
      await waitFor(() => views.filter((v) => v.phase === "moving").length >= 2, 1500)
    ).toBe(true);
    expect(views.filter((v) => v.phase === "moving")[1].roundDeadline).toBeNull();
  }, 8000);

  it("a reset match stamps a FRESH deadline — the old one is never reused and cannot resolve it", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 800 });
    const { roomId, sessions } = makeRoom(server, 2);
    const views = viewEvents(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(views.length).toBeGreaterThan(0);
    const oldDeadline = views[0].roundDeadline as number; // ≈ start + 800

    // Mid-window, the server resets the match (comfortably before the old
    // deadline could fire).
    await sleep(400);
    expect(server.resetMatch(roomId)).toEqual({ ok: true });
    const resetView = views[views.length - 1];
    expect(resetView.phase).toBe("aiming");
    expect(resetView.roundDeadline as number).toBeGreaterThan(oldDeadline); // ≈ reset + 800

    // Wait deterministically until the OLD deadline moment has passed…
    expect(
      await waitFor(() => Date.now() > oldDeadline + 150, 3000)
    ).toBe(true);
    // …the new match's round must still be open (a reused old deadline
    // would have resolved it right at oldDeadline)…
    expect(views.every((v) => v.phase !== "moving")).toBe(true);
    // …and it resolves only at the NEW one.
    expect(await waitFor(() => views.some((v) => v.phase === "moving"), 3000)).toBe(true);
  }, 10000);

  it("a disconnect never changes the stamp; a reconnect receives the CURRENT deadline (no fresh window)", async () => {
    const server = newServer({
      roundDecisionTimeoutMs: 5_000,
      reconnectReservationMs: 10_000,
    });
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const views = viewEvents(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(views.length).toBeGreaterThan(0);
    const original = views[0].roundDeadline as number;

    // p1 drops mid-round: the deadline stamp is untouched (any push during
    // the round still carries the ORIGINAL value).
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY });
    expect(views.length).toBeGreaterThan(1);
    expect(views[1].roundDeadline).toBe(original);

    // The recovering player's own subscribe-time push carries the SAME
    // current deadline — not a fresh window, not the pre-drop round's.
    const recoveredViews = viewEvents(server, sessions[1]);
    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    expect(recoveredViews.length).toBeGreaterThan(0);
    expect(recoveredViews[0].phase).toBe("aiming");
    expect(recoveredViews[0].roundDeadline).toBe(original);
  });

  it("one SHARED round deadline for the whole room — never per-player deadlines", async () => {
    const server = newServer({ roundDecisionTimeoutMs: 5_000 });
    const { roomId, sessions } = makeRoom(server, 3);
    const v0 = viewEvents(server, sessions[0]);
    const v1 = viewEvents(server, sessions[1]);
    const v2 = viewEvents(server, sessions[2]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(
      await waitFor(() => v0.length > 0 && v1.length > 0 && v2.length > 0, 3000)
    ).toBe(true);
    // Every viewer's snapshot of the SAME round carries the SAME stamp…
    expect(v1[0].roundDeadline).toBe(v0[0].roundDeadline);
    expect(v2[0].roundDeadline).toBe(v0[0].roundDeadline);
    // …and a player acting during the round does not fork it.
    server.submitCommand(sessions[2], { type: "aim", x: CX, y: CY });
    expect(v2.length).toBeGreaterThan(1);
    expect(v2[1].roundDeadline).toBe(v0[0].roundDeadline);
  });
});
