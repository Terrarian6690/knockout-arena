import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  type GameState,
  type GameStateSnapshot,
} from "../../game";
import { createGameHost, DEFAULT_MATCH_DURATION_MS, type GameHost } from "../gameHost";
import { createGameServer, type GameServer, type Session } from "../index";

/**
 * THE MATCH TIME LIMIT — server half (Task 6).
 *
 * The server owns the clock: the engine has none. These tests pin the
 * authoritative behavior end to end:
 *
 *   - the 4-minute limit is exact, and it starts when the MATCH starts
 *     (a room waiting in the lobby has no timer at all);
 *   - it fires regardless of phase, without ever interrupting a fixed
 *     timestep;
 *   - ORDERING: when the limit coincides with the round deadline, the
 *     match ends (the round does not resolve); when it coincides with an
 *     arena shrink, the round that carries the shrink has already
 *     completed, so the shrink stands and the match then ends;
 *   - a natural winner before the limit prevents any later finish;
 *   - clients receive an ABSOLUTE deadline on the snapshot, including
 *     immediately on (re)subscribe;
 *   - a reset arms a fresh full-length timer.
 *
 * Every clock is injected, so nothing here waits in real time.
 */

const TICK = CONFIG.simulation.fixedTimestepMs;
const DURATION = CONFIG.match.durationMs;
const ROUND_MS = 10_000;

const liveHosts: GameHost[] = [];
const liveServers: GameServer[] = [];

afterEach(() => {
  for (const h of liveHosts) h.destroy();
  liveHosts.length = 0;
  for (const s of liveServers) s.destroy();
  liveServers.length = 0;
});

function specs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    colorIndex: i,
  }));
}

/** A host with an injected clock the test advances by hand. */
function newHost(
  now: { t: number },
  options: { players?: number; matchDurationMs?: number; roundDecisionTimeoutMs?: number } = {}
): GameHost {
  const host = createGameHost({
    players: specs(options.players ?? 2),
    clock: () => now.t,
    matchDurationMs: options.matchDurationMs,
    roundDecisionTimeoutMs: options.roundDecisionTimeoutMs ?? ROUND_MS,
  });
  liveHosts.push(host);
  return host;
}

const stateOf = (h: GameHost): GameState =>
  deserializeGameState(h.serializedState());

/**
 * Advance the injected clock to an absolute time, ticking the host at the
 * fixed cadence — exactly how the real loop behaves, one whole tick at a
 * time. Never steps the clock mid-tick.
 */
function advanceTo(h: GameHost, now: { t: number }, target: number): number {
  let steps = 0;
  while (now.t < target && steps < 100_000) {
    now.t = Math.min(target, now.t + TICK);
    h.tick();
    steps += 1;
  }
  return steps;
}

/**
 * Idle pawns are eventually eliminated by the shrinking arena, which
 * would end a match NATURALLY long before four minutes. Tests about the
 * clock itself therefore use a round window longer than the match: with
 * nobody confirming, no round ever resolves, so nothing but the time
 * limit can finish the match.
 */
const NO_ROUND_RESOLUTION = { roundDecisionTimeoutMs: DURATION * 10 };

/** Drive both pawns to the middle so later shrinks cannot eliminate them. */
function gatherAtCenter(h: GameHost, now: { t: number }, rounds: number): void {
  for (let r = 0; r < rounds; r++) {
    for (const p of stateOf(h).pawns) {
      if (p.eliminated) continue;
      h.submitCommand({
        type: "aim",
        playerId: p.id,
        x: CONFIG.arena.centerX,
        y: CONFIG.arena.centerY,
      });
      h.submitCommand({ type: "setPower", playerId: p.id, power: 2 });
      h.submitCommand({ type: "confirmLaunch", playerId: p.id });
    }
    let guard = 0;
    while (stateOf(h).phase === "moving" && guard++ < 5_000) {
      now.t += TICK;
      h.tick();
    }
  }
}

function newServer(options: {
  matchDurationMs?: number;
  roundDecisionTimeoutMs?: number;
} = {}): GameServer {
  const server = createGameServer(options);
  liveServers.push(server);
  return server;
}

function makeRoom(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[]; tokens: string[] } {
  const sessions: Session[] = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  if (!created.ok) throw new Error("createRoom failed");
  sessions.push(creator);
  tokens.push(created.reconnectToken);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, roomId);
    if (!joined.ok) throw new Error("joinRoom failed");
    sessions.push(s);
    tokens.push(joined.reconnectToken);
  }
  return { roomId, sessions, tokens };
}

function viewSink(server: GameServer, session: Session): GameStateSnapshot[] {
  const views: GameStateSnapshot[] = [];
  server.onRoomView(session, (view) => views.push(view));
  return views;
}

const last = (views: GameStateSnapshot[]): GameStateSnapshot => {
  const v = views[views.length - 1];
  if (v === undefined) throw new Error("no view pushed");
  return v;
};

describe("the 4-minute limit: duration and start", () => {
  it("defaults to exactly 4 minutes", () => {
    expect(DEFAULT_MATCH_DURATION_MS).toBe(240_000);
    expect(CONFIG.match.durationMs).toBe(4 * 60 * 1000);
  });

  it("arms the deadline at match start, exactly one duration ahead", () => {
    const now = { t: 1_000 };
    const h = newHost(now);
    expect(h.matchDeadline()).toBe(1_000 + DURATION);
  });

  it("does NOT finish one millisecond early", () => {
    const now = { t: 0 };
    const h = newHost(now, NO_ROUND_RESOLUTION);
    advanceTo(h, now, DURATION - 1);
    expect(stateOf(h).phase).not.toBe("finished");
    expect(h.matchDeadline()).not.toBeNull();
  });

  it("finishes exactly AT the 4-minute mark", () => {
    const now = { t: 0 };
    const h = newHost(now, NO_ROUND_RESOLUTION);
    advanceTo(h, now, DURATION);
    expect(stateOf(h).phase).toBe("finished");
    expect(h.matchDeadline()).toBeNull(); // consumed, never re-fires
  });

  it("counts from match start, not from process/room creation", () => {
    // A room can exist long before a match does. The host IS the match,
    // so a host created later gets its full duration from that moment.
    const now = { t: 500_000 }; // "the lobby has been open for a while"
    const h = newHost(now, NO_ROUND_RESOLUTION);
    expect(h.matchDeadline()).toBe(500_000 + DURATION);
    advanceTo(h, now, 500_000 + DURATION - TICK);
    expect(stateOf(h).phase).not.toBe("finished");
    advanceTo(h, now, 500_000 + DURATION);
    expect(stateOf(h).phase).toBe("finished");
  });

  it("a room WAITING in the lobby has no match timer at all", () => {
    const server = newServer();
    const { roomId } = makeRoom(server, 2);
    // No match yet: nothing is counting down.
    expect(server.getRoom(roomId)!.state).toBe("waiting");
    const sessions = makeRoom(server, 2).sessions;
    // …and no view carries a deadline either (there is no match to view).
    const views = viewSink(server, sessions[0]);
    expect(views).toHaveLength(0);
  });

  it("starts the clock only when startMatch runs", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const before = Date.now();
    expect(server.startMatch(roomId).ok).toBe(true);
    const view = last(viewSink(server, sessions[0]));
    expect(typeof view.matchDeadline).toBe("number");
    // The deadline is ~one duration from NOW (start), not from earlier.
    const remaining = view.matchDeadline! - before;
    expect(remaining).toBeGreaterThan(DURATION - 5_000);
    expect(remaining).toBeLessThanOrEqual(DURATION + 1_000);
  });
});

describe("the limit fires in every phase, between whole ticks", () => {
  it("ends a match sitting in the AIMING phase", () => {
    const now = { t: 0 };
    // A round deadline longer than the match, so the match limit is
    // certain to be the thing that fires.
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });
    expect(stateOf(h).phase).toBe("aiming");
    advanceTo(h, now, DURATION);
    expect(stateOf(h).phase).toBe("finished");
  });

  it("ends a match whose round is still RESOLVING", () => {
    const now = { t: 0 };
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });
    // Get the match moving just before the limit.
    advanceTo(h, now, DURATION - 2 * TICK);
    h.submitCommand({ type: "aim", playerId: "p0", x: 450, y: 350 });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 5 });
    h.submitCommand({ type: "confirmLaunch", playerId: "p0" });
    h.submitCommand({ type: "resolveRound" });
    expect(stateOf(h).phase).toBe("moving");

    advanceTo(h, now, DURATION);
    expect(stateOf(h).phase).toBe("finished");
  });

  it("never interrupts a fixed timestep (ticks stay whole)", () => {
    const now = { t: 0 };
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });
    const before = h.tickCount();
    const steps = advanceTo(h, now, DURATION);
    const after = h.tickCount();
    // Every clock advance ran exactly ONE whole fixed tick: no partial
    // step was simulated to land on the deadline, and no extra tick was
    // executed to finish the match. The limit is evaluated strictly
    // between whole ticks.
    expect(after - before).toBe(steps);
    expect(steps).toBeGreaterThan(14_000); // ~4 min at 60 Hz
    expect(stateOf(h).phase).toBe("finished");
  });

  it("still fires between ticks when the loop is only pumping", async () => {
    // The real loop path (no manual ticks): a very short match resolved
    // by the interval pump.
    const host = createGameHost({
      players: specs(2),
      matchDurationMs: 60,
      roundDecisionTimeoutMs: 10_000,
    });
    liveHosts.push(host);
    host.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(deserializeGameState(host.serializedState()).phase).toBe("finished");
    host.stop();
  });
});

describe("deterministic ordering against the round deadline", () => {
  it("the MATCH LIMIT wins when both are due on the same tick", () => {
    const now = { t: 0 };
    // Round deadline lands exactly on the match deadline.
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION });
    expect(h.roundDeadline()).toBe(DURATION);
    expect(h.matchDeadline()).toBe(DURATION);

    advanceTo(h, now, DURATION);
    const s = stateOf(h);
    // The match ended; the coincident round was NOT resolved into a
    // movement phase.
    expect(s.phase).toBe("finished");
    expect(s.round.settleTicks).toBe(0);
    // Both tokens are gone — nothing can fire afterwards.
    expect(h.matchDeadline()).toBeNull();
    expect(h.roundDeadline()).toBeNull();
  });

  it("is stable across repeated runs (same inputs → same outcome)", () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const now = { t: 0 };
      const h = newHost(now, { roundDecisionTimeoutMs: DURATION });
      advanceTo(h, now, DURATION);
      const s = stateOf(h);
      outcomes.add(`${s.phase}|${s.winnerId}|${s.round.settleTicks}`);
    }
    expect(outcomes.size).toBe(1);
  });

  it("leaves the 10-second round deadline unchanged before the limit", () => {
    const now = { t: 0 };
    const h = newHost(now); // default 10 s rounds
    expect(h.roundDeadline()).toBe(ROUND_MS);
    // The first round resolves at 10 s, exactly as before the time limit
    // existed — the match clock does not disturb it.
    advanceTo(h, now, ROUND_MS);
    expect(stateOf(h).phase).toBe("moving");
    expect(h.matchDeadline()).toBe(DURATION); // still running
  });

  it("keeps resolving 10-second rounds right up to the match limit", () => {
    const now = { t: 0 };
    const h = newHost(now); // default 10 s round deadline
    // Both pawns huddle in the middle, so the shrinking arena cannot
    // eliminate them and end the match early: the clock decides.
    gatherAtCenter(h, now, 2);

    let resolutions = 0;
    let previous = stateOf(h).phase;
    let guard = 0;
    while (now.t < DURATION && guard++ < 100_000) {
      now.t += TICK;
      h.tick();
      const phase = stateOf(h).phase;
      if (previous !== "moving" && phase === "moving") resolutions += 1;
      previous = phase;
      if (phase === "finished") break;
    }
    const s = stateOf(h);
    expect(s.phase).toBe("finished");
    // It ended on the FIRST tick at or after the limit — not a moment
    // before, and within one fixed timestep of it (ticks are whole).
    expect(now.t).toBeGreaterThanOrEqual(DURATION);
    expect(now.t).toBeLessThan(DURATION + TICK);
    // Rounds kept turning over on their own 10 s cadence throughout:
    // ~4 minutes of play, untouched by the match clock.
    expect(resolutions).toBeGreaterThan(15);
    expect(s.pawns.filter((p) => !p.eliminated).length).toBeGreaterThan(0);
  });
});

describe("deterministic ordering against the arena shrink", () => {
  it("a shrink completed at the same boundary stands, then the match ends", () => {
    // The shrink belongs to a COMPLETED round; the match limit ends the
    // match afterwards. Both effects are visible in the final state, and
    // the order (shrink, then finish) is fixed.
    const now = { t: 0 };
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });

    const every = CONFIG.arena.shrink.everyRounds;
    // Complete exactly `every` rounds so the next resolution shrinks.
    for (let r = 0; r < every - 1; r++) {
      h.submitCommand({ type: "resolveRound" });
      let guard = 0;
      while (stateOf(h).phase === "moving" && guard++ < 5_000) {
        now.t += TICK;
        h.tick();
      }
    }
    expect(stateOf(h).arena!.radius).toBe(CONFIG.arena.radius);
    expect(stateOf(h).arena!.roundsSinceShrink).toBe(every - 1);

    // The round that triggers the shrink resolves…
    h.submitCommand({ type: "resolveRound" });
    let guard = 0;
    while (stateOf(h).phase === "moving" && guard++ < 5_000) {
      now.t += TICK;
      h.tick();
    }
    const shrunk = CONFIG.arena.radius - CONFIG.arena.shrink.amount;
    expect(stateOf(h).arena!.radius).toBe(shrunk);

    // …and then the clock runs out.
    advanceTo(h, now, DURATION);
    const s = stateOf(h);
    expect(s.phase).toBe("finished");
    expect(s.arena!.radius).toBe(shrunk); // the shrink was NOT undone
    expect(s.arena!.roundsSinceShrink).toBe(0); // nor the schedule reset
  });

  it("ends the match after SEVERAL shrinks, at the fully shrunken radius", () => {
    const now = { t: 0 };
    const h = newHost(now); // default 10 s rounds → many rounds in 4 min
    // Keep both pawns central so they survive every shrink and the match
    // is still running when the clock expires.
    gatherAtCenter(h, now, 2);
    advanceTo(h, now, DURATION);

    const s = stateOf(h);
    expect(s.phase).toBe("finished");
    // 4 minutes of 10-second rounds is far more than the 12 rounds
    // needed to reach the floor: the arena is at its minimum, and the
    // timeout preserved exactly what the schedule produced.
    expect(s.arena!.radius).toBe(CONFIG.arena.shrink.minRadius);
    expect(s.winnerId).not.toBeNull(); // decided by the tie-break
  });

  it("the match limit never resets the shrink schedule", () => {
    const now = { t: 0 };
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });
    h.submitCommand({ type: "resolveRound" });
    let guard = 0;
    while (stateOf(h).phase === "moving" && guard++ < 5_000) {
      now.t += TICK;
      h.tick();
    }
    const before = stateOf(h).arena;
    expect(before!.roundsSinceShrink).toBe(1);
    advanceTo(h, now, DURATION);
    expect(stateOf(h).arena).toEqual(before);
  });
});

describe("a natural finish before the limit", () => {
  it("prevents any later time-limit finish", () => {
    const now = { t: 0 };
    const h = newHost(now, { players: 2, roundDecisionTimeoutMs: DURATION * 10 });
    // p0 launches itself out: p1 wins naturally, long before 4 minutes.
    const me = stateOf(h).pawns.find((p) => p.id === "p0")!;
    const dx = me.position.x - CONFIG.arena.centerX || 1;
    const dy = me.position.y - CONFIG.arena.centerY;
    const len = Math.hypot(dx, dy) || 1;
    h.submitCommand({
      type: "aim",
      playerId: "p0",
      x: CONFIG.arena.centerX + (dx / len) * 400,
      y: CONFIG.arena.centerY + (dy / len) * 400,
    });
    h.submitCommand({ type: "setPower", playerId: "p0", power: 5 });
    h.submitCommand({ type: "confirmLaunch", playerId: "p0" });
    h.submitCommand({ type: "resolveRound" });
    let guard = 0;
    while (stateOf(h).phase === "moving" && guard++ < 5_000) {
      now.t += TICK;
      h.tick();
    }
    const natural = stateOf(h);
    expect(natural.phase).toBe("finished");
    expect(natural.winnerId).toBe("p1");
    // The match timer was dropped the moment the match finished.
    expect(h.matchDeadline()).toBeNull();

    // Running well past 4 minutes changes nothing at all.
    let pushes = 0;
    h.onStateChange(() => pushes++);
    const baseline = pushes; // the immediate push on subscribe
    advanceTo(h, now, DURATION * 2);
    expect(stateOf(h)).toEqual(natural);
    expect(pushes).toBe(baseline); // no second finish, no extra broadcast
  });
});

describe("clients receive the authoritative deadline", () => {
  it("stamps an absolute matchDeadline on every viewer snapshot", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    const asP0 = viewSink(server, sessions[0]);
    const asP1 = viewSink(server, sessions[1]);
    const a = last(asP0);
    const b = last(asP1);
    expect(typeof a.matchDeadline).toBe("number");
    // Identical for every viewer: one authoritative clock, not per-client.
    expect(a.matchDeadline).toBe(b.matchDeadline);
    // It is a FUTURE absolute timestamp, not a remaining duration.
    expect(a.matchDeadline!).toBeGreaterThan(Date.now());
    expect(a.matchDeadline!).toBeLessThanOrEqual(Date.now() + DURATION);
  });

  it("a late subscriber (reconnect) immediately gets the correct deadline", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    const original = last(viewSink(server, sessions[0])).matchDeadline;

    // p1 drops and comes back: the FIRST view it receives already
    // carries the same absolute deadline — nothing to re-derive locally.
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    const back = server.reconnect(tokens[1]);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error("unreachable");
    const afterReconnect = viewSink(server, back.session);
    expect(afterReconnect.length).toBeGreaterThan(0);
    expect(last(afterReconnect).matchDeadline).toBe(original);
  });

  it("reports no deadline once the match has finished", () => {
    const server = newServer({ matchDurationMs: 40 });
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    const views = viewSink(server, sessions[0]);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const view = last(views);
        expect(view.phase).toBe("finished");
        // The finished UI owns the screen now; no clock keeps running.
        expect(view.matchDeadline).toBeNull();
        resolve();
      }, 300);
    });
  });

  it("keeps the deadline stable across snapshots (no drift, no backwards jumps)", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    const views = viewSink(server, sessions[0]);
    // Provoke several pushes.
    for (let i = 0; i < 5; i++) {
      server.submitCommand(sessions[0], { type: "aim", x: 450, y: 350 + i });
    }
    const deadlines = views
      .map((v) => v.matchDeadline)
      .filter((d): d is number => typeof d === "number");
    expect(deadlines.length).toBeGreaterThan(1);
    // One match, one deadline: every snapshot agrees.
    expect(new Set(deadlines).size).toBe(1);
  });

  it("players cannot submit timeUp over the wire", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.submitCommand(sessions[0], { type: "timeUp" })).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    // …and the match is untouched.
    expect(last(viewSink(server, sessions[0])).phase).toBe("aiming");
  });
});

describe("reset gives a fresh 4-minute timer", () => {
  it("re-arms the full duration from the reset moment", () => {
    const now = { t: 0 };
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });
    advanceTo(h, now, DURATION / 2); // halfway through
    expect(h.matchDeadline()).toBe(DURATION);

    expect(h.submitCommand({ type: "reset" }).ok).toBe(true);
    expect(h.matchDeadline()).toBe(now.t + DURATION);
    expect(stateOf(h).phase).toBe("aiming");

    // The new match runs its own full length.
    advanceTo(h, now, now.t + DURATION - TICK);
    expect(stateOf(h).phase).not.toBe("finished");
    advanceTo(h, now, h.matchDeadline()!);
    expect(stateOf(h).phase).toBe("finished");
  });

  it("re-arms after a time-limit finish too", () => {
    const now = { t: 0 };
    const h = newHost(now, { roundDecisionTimeoutMs: DURATION * 10 });
    advanceTo(h, now, DURATION);
    expect(stateOf(h).phase).toBe("finished");
    expect(h.matchDeadline()).toBeNull();

    expect(h.submitCommand({ type: "reset" }).ok).toBe(true);
    expect(h.matchDeadline()).toBe(now.t + DURATION);
    expect(stateOf(h).phase).toBe("aiming");
  });
});
