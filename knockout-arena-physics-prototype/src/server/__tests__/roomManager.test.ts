import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  type GameState,
} from "../../game";
import {
  createGameServer,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type GameServer,
  type Session,
} from "../index";

/**
 * Room/Match manager + session behavior — driven entirely through the
 * GameServer facade, exactly the way a future WebSocket transport will.
 *
 * What these tests pin:
 *   - the identity chain: session → room → server-assigned playerId
 *     (p0..p3, join order, never client-chosen);
 *   - command ownership: submitCommand(session, cmd) stamps the seat's
 *     playerId; forged playerIds in the payload are ignored;
 *   - room lifecycle: waiting → playing → finished, roster frozen at
 *     start, joins blocked once playing, clean leaves, empty-room cleanup;
 *   - reset as a privileged server action;
 *   - malformed session/command input never crashes the server;
 *   - independent simultaneous rooms.
 *
 * Match state is observed the way the transport will observe it: through
 * onRoomState pushes of the serialized authoritative state.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── helpers ───────────────────────────────────────────────────────────────

const liveServers: GameServer[] = [];
function newServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

/** A room with n seated sessions (creator + n-1 joiners), not yet started. */
function makeRoom(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[]; playerIds: string[] } {
  const sessions: Session[] = [];
  const playerIds: string[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  sessions.push(creator);
  playerIds.push(created.playerId);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, roomId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error("unreachable");
    sessions.push(s);
    playerIds.push(joined.playerId);
  }
  return { roomId, sessions, playerIds };
}

/** Captured state pipe for one session (the transport broadcast pattern). */
function statePipe(server: GameServer, session: Session): string[] {
  const received: string[] = [];
  server.onRoomState(session, (s) => received.push(s));
  return received;
}

function latestState(received: string[]): GameState {
  const last = received[received.length - 1];
  if (!last) throw new Error("no state received yet");
  return deserializeGameState(last);
}

/** A safe inward aim target for the given pawn's session. */
function aimAtCenter(server: GameServer, session: Session) {
  return server.submitCommand(session, { type: "aim", x: CX, y: CY });
}

/** Poll until the predicate holds (real-time match progression). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ────────────────────────────────────────────────────────────────────────
// Sessions — the root of the identity chain
// ────────────────────────────────────────────────────────────────────────

describe("sessions", () => {
  it("connect() issues unique opaque sessions", () => {
    const server = newServer();
    const a = server.connect();
    const b = server.connect();
    expect(a.token).toBeTruthy();
    expect(a.token).not.toBe(b.token);
    expect(server.sessionCount()).toBe(2);
  });

  it("malformed session input never crashes the server", () => {
    const server = newServer();
    const { roomId } = makeRoom(server, 2);
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "session",
      true,
      [],
      {},
      { token: 42 },
      { token: "" },
      { token: "forged-token" },
      () => {},
    ];
    for (const bad of junk) {
      expect(server.submitCommand(bad, { type: "aim", x: CX, y: CY })).toEqual({
        ok: false,
        reason: "unknown-session",
      });
      expect(server.createRoom(bad)).toEqual({ ok: false, reason: "unknown-session" });
      expect(server.joinRoom(bad, roomId).ok).toBe(false);
      expect(server.leaveRoom(bad).ok).toBe(false);
      expect(server.getSeat(bad)).toBeNull();
      expect(server.disconnect(bad)).toBe(false);
      const unsub = server.onRoomState(bad, () => {});
      expect(typeof unsub).toBe("function");
      unsub();
    }
    // The server is unharmed and fully operational afterwards.
    const { roomId: fresh } = makeRoom(server, 2);
    expect(server.getRoom(fresh)).not.toBeNull();
  });

  it("disconnect() invalidates the session and leaves its room cleanly", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.disconnect(sessions[0])).toBe(true);
    expect(server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "unknown-session",
    });
    expect(server.getSeat(sessions[0])).toBeNull();
    expect(server.sessionCount()).toBe(1);
    // Room survives with the other player; the seat freed up.
    const room = server.getRoom(roomId)!;
    expect(room.state).toBe("waiting");
    expect(room.seats).toHaveLength(1);
    expect(room.seats[0].playerId).toBe("p1");
  });

  it("documents the interim trust model: the token is the credential", () => {
    // Until real authentication lands, a session object is just a carrier
    // for the unguessable token — anything holding the token IS the
    // session. Locking this in makes the future auth boundary explicit.
    const server = newServer();
    const session = server.connect();
    const carrier = { token: session.token, connectedAt: 0 };
    expect(server.createRoom(carrier).ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Room creation, joining and seat assignment
// ────────────────────────────────────────────────────────────────────────

describe("room creation and joining", () => {
  it("creates a room and seats the creator as p0", () => {
    const server = newServer();
    const session = server.connect();
    const result = server.createRoom(session);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.playerId).toBe("p0");
    expect(result.room.id).toBeTruthy();
    expect(result.room.state).toBe("waiting");
    expect(result.room.seats).toEqual([{ playerId: "p0", connected: true }]);
  });

  it("assigns p0/p1/p2/p3 exclusively by join order", () => {
    const server = newServer();
    const { roomId, playerIds } = makeRoom(server, MAX_PLAYERS);
    expect(playerIds).toEqual(["p0", "p1", "p2", "p3"]);
    const room = server.getRoom(roomId)!;
    expect(room.seats.map((s) => s.playerId)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(room.seats.every((s) => s.connected)).toBe(true);
    expect(MIN_PLAYERS).toBe(2);
    expect(MAX_PLAYERS).toBe(4);
  });

  it("rejects a fifth player (room-full)", () => {
    const server = newServer();
    const { roomId } = makeRoom(server, 4);
    const fifth = server.connect();
    expect(server.joinRoom(fifth, roomId)).toEqual({ ok: false, reason: "room-full" });
    expect(server.getRoom(roomId)!.seats).toHaveLength(4); // unchanged
    expect(server.getSeat(fifth)).toBeNull();
  });

  it("resolves the identity chain: session → room → playerId", () => {
    const server = newServer();
    const { roomId, sessions, playerIds } = makeRoom(server, 3);
    for (let i = 0; i < sessions.length; i++) {
      const seat = server.getSeat(sessions[i])!;
      expect(seat.room.id).toBe(roomId);
      expect(seat.playerId).toBe(playerIds[i]);
    }
    // A roomless session resolves to nothing.
    const roomless = server.connect();
    expect(server.getSeat(roomless)).toBeNull();
  });

  it("rejects joining unknown rooms", () => {
    const server = newServer();
    const session = server.connect();
    expect(server.joinRoom(session, "no-such-room")).toEqual({
      ok: false,
      reason: "unknown-room",
    });
    expect(server.joinRoom(session, 42)).toEqual({ ok: false, reason: "unknown-room" });
    expect(server.joinRoom(session, null)).toEqual({ ok: false, reason: "unknown-room" });
  });

  it("a seated session cannot create or join another room", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.createRoom(sessions[0])).toEqual({
      ok: false,
      reason: "already-in-room",
    });
    const other = makeRoom(server, 2);
    expect(server.joinRoom(sessions[0], other.roomId)).toEqual({
      ok: false,
      reason: "already-in-room",
    });
    expect(server.roomCount()).toBe(2); // both rooms intact
    expect(server.getRoom(roomId)!.seats).toHaveLength(2);
  });

  it("leaving a waiting room frees the seat for the next joiner", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3); // p0 p1 p2
    expect(server.leaveRoom(sessions[1])).toEqual({ ok: true, room: expect.any(Object) });

    const room = server.getRoom(roomId)!;
    expect(room.seats.map((s) => s.playerId)).toEqual(["p0", "p2"]);

    // The freed seat is reused (lowest free first) — the newcomer cannot
    // choose which id they get.
    const newcomer = server.connect();
    const joined = server.joinRoom(newcomer, roomId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error("unreachable");
    expect(joined.playerId).toBe("p1");

    // A fully departed player can create a fresh room again.
    expect(server.leaveRoom(sessions[2]).ok).toBe(true);
    expect(server.createRoom(sessions[2]).ok).toBe(true);
  });

  it("removes a room once the last player leaves", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    server.leaveRoom(sessions[0]);
    expect(server.getRoom(roomId)).not.toBeNull();
    server.leaveRoom(sessions[1]);
    expect(server.getRoom(roomId)).toBeNull();
    expect(server.roomCount()).toBe(0);
    // The sweep is a no-op when nothing is empty (cleanup is automatic).
    expect(server.removeEmptyRooms()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Match lifecycle
// ────────────────────────────────────────────────────────────────────────

describe("match lifecycle", () => {
  it("refuses to start without enough players", () => {
    const server = newServer();
    const session = server.connect();
    const created = server.createRoom(session);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(server.startMatch(created.room.id)).toEqual({
      ok: false,
      reason: "not-enough-players",
    });
    expect(server.getRoom(created.room.id)!.state).toBe("waiting");
  });

  it("starts a stable roster and freezes the room", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    const started = server.startMatch(roomId);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("unreachable");
    expect(started.room.state).toBe("playing");
    expect(started.room.seats.map((s) => s.playerId)).toEqual(["p0", "p1", "p2"]);

    // No joins after the match starts — the roster is frozen.
    const latecomer = server.connect();
    expect(server.joinRoom(latecomer, roomId)).toEqual({
      ok: false,
      reason: "room-playing",
    });
    // Starting again is rejected too.
    expect(server.startMatch(roomId)).toEqual({ ok: false, reason: "already-playing" });

    // Commands work through the sessions.
    expect(aimAtCenter(server, sessions[0])).toEqual({ ok: true });
  });

  it("starts with the occupied seats only (a pre-start leave is excluded)", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3); // p0 p1 p2
    server.leaveRoom(sessions[1]); // p1 leaves before the match
    const started = server.startMatch(roomId);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("unreachable");
    // Stable roster = occupied seats at start time: p0 and p2.
    expect(started.room.seats.map((s) => s.playerId)).toEqual(["p0", "p2"]);
    expect(aimAtCenter(server, sessions[0])).toEqual({ ok: true });
  });

  it("a mid-match leave vacates the seat but keeps the roster and match", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const p0States = statePipe(server, sessions[0]);
    server.startMatch(roomId);

    expect(server.leaveRoom(sessions[1])).toEqual({ ok: true, room: expect.any(Object) });
    const room = server.getRoom(roomId)!;
    expect(room.state).toBe("playing");
    expect(room.seats).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: false }, // vacated, still in the roster
    ]);

    // The match continues for the remaining player; the leaver is out.
    expect(aimAtCenter(server, sessions[0])).toEqual({ ok: true });
    expect(server.submitCommand(sessions[1], { type: "aim", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "not-in-room",
    });
    expect(latestState(p0States).pawns).toHaveLength(2); // roster intact
  });

  it("commands in a waiting room are rejected (no match yet)", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "no-match",
    });
    expect(server.getRoom(roomId)!.state).toBe("waiting");
  });

  it("commands from a roomless session are rejected", () => {
    const server = newServer();
    const session = server.connect();
    expect(server.submitCommand(session, { type: "aim", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "not-in-room",
    });
  });

  it("reaches the finished lifecycle state when the match ends", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    server.startMatch(roomId);
    expect(states.length).toBeGreaterThan(0); // initial state pushed at start

    // p0 eliminates itself: radial outward p5 launch over the rim.
    const me = latestState(states).pawns[0];
    const dx = me.position.x - CX || 1;
    const dy = me.position.y - CY;
    const len = Math.hypot(dx, dy) || 1;
    expect(
      server.submitCommand(sessions[0], {
        type: "aim",
        playerId: "p1", // forged — must be ignored
        x: CX + (dx / len) * 400,
        y: CY + (dy / len) * 400,
      })
    ).toEqual({ ok: true });
    server.submitCommand(sessions[0], { type: "setPower", power: 5 });
    server.submitCommand(sessions[0], { type: "confirmLaunch" });

    // The real 60 Hz loop resolves the match (flight + settle ≈ 1-2 s).
    const finished = await waitFor(
      () => server.getRoom(roomId)!.state === "finished",
      5000
    );
    expect(finished).toBe(true);
    const final = latestState(states);
    expect(final.phase).toBe("finished");
    expect(final.winnerId).toBe("p1");
  }, 8000);
});

// ────────────────────────────────────────────────────────────────────────
// Command identity — the server never trusts the wire playerId
// ────────────────────────────────────────────────────────────────────────

describe("command identity", () => {
  it("applies commands with the session's identity", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    server.startMatch(roomId);

    expect(server.submitCommand(sessions[0], { type: "aim", x: CX + 100, y: CY })).toEqual({
      ok: true,
    });
    expect(server.submitCommand(sessions[0], { type: "setPower", power: 4 })).toEqual({
      ok: true,
    });

    const s = latestState(states);
    expect(s.pawns[0].aim.active).toBe(true); // p0 (session 0) aimed
    expect(s.pawns[0].power).toBe(4);
    expect(s.pawns[1].aim.active).toBe(false); // p1 untouched
  });

  it("a forged playerId cannot change command ownership", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    server.startMatch(roomId);

    // p0's session claims to be p1 during p0's turn. Had the server
    // trusted the payload, this would be p1 acting out of turn
    // (wrong-player). Instead it is applied as p0's own aim.
    expect(
      server.submitCommand(sessions[0], { type: "aim", playerId: "p1", x: CX, y: CY })
    ).toEqual({ ok: true });
    let s = latestState(states);
    expect(s.pawns[0].aim.active).toBe(true); // owner = session's seat
    expect(s.pawns[1].aim.active).toBe(false);

    expect(
      server.submitCommand(sessions[0], { type: "setPower", playerId: "p1", power: 5 })
    ).toEqual({ ok: true });
    s = latestState(states);
    expect(s.pawns[0].power).toBe(5); // p0's power, not p1's
    expect(s.pawns[1].power).toBe(CONFIG.power.default);

    // The same for the launch: p0's session "confirming as p1" launches p0.
    expect(
      server.submitCommand(sessions[0], { type: "confirmLaunch", playerId: "p1" })
    ).toEqual({ ok: true });
    expect(latestState(states).phase).toBe("moving"); // p0 launched
  });

  it("strips unknown fields — only known intent fields pass the boundary", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    server.startMatch(roomId);

    expect(
      server.submitCommand(sessions[0], {
        type: "aim",
        playerId: "p1",
        x: CX,
        y: CY,
        hack: "please",
        winnerId: "p1", // outcome forgery attempt
      })
    ).toEqual({ ok: true });
    const s = latestState(states);
    expect(s.pawns[0].aim.active).toBe(true); // applied as p0's aim
    expect(s.pawns[1].aim.active).toBe(false);
    expect(s.winnerId).toBeNull(); // no outcome was installed
  });

  it("still rejects malformed commands after identity stamping", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    server.startMatch(roomId);
    for (const bad of [
      null,
      42,
      "aim",
      {},
      { type: "aim", x: "left", y: 1 }, // missing playerId is fine — stamped
      { type: "aim", x: NaN, y: 1 }, // ...but junk fields are not
      { type: "teleport", x: 0, y: 0 },
    ]) {
      expect(server.submitCommand(sessions[0], bad)).toEqual({
        ok: false,
        reason: "invalid-command",
      });
    }
    // Server still healthy.
    expect(aimAtCenter(server, sessions[0])).toEqual({ ok: true });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reset authorization
// ────────────────────────────────────────────────────────────────────────

describe("reset authorization", () => {
  it("rejects player-issued resets — only the server may reset", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    server.startMatch(roomId);
    server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY });
    const before = latestState(states);
    const emissionsBefore = states.length;

    // Neither player may reset the match through the command path —
    // with or without dressing the payload up as something else.
    expect(server.submitCommand(sessions[0], { type: "reset" })).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(server.submitCommand(sessions[1], { type: "reset" })).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(server.submitCommand(sessions[1], { type: "reset", playerId: "p0" })).toEqual({
      ok: false,
      reason: "unauthorized",
    });

    // Nothing changed: no new state, same aim.
    expect(states.length).toBe(emissionsBefore);
    expect(latestState(states)).toEqual(before);
  });

  it("the privileged server path resets the match", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    server.startMatch(roomId);
    const initial = states[0]; // first push = pristine match state

    server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY });
    server.submitCommand(sessions[0], { type: "setPower", power: 5 });
    expect(latestState(states).pawns[0].aim.active).toBe(true);

    expect(server.resetMatch(roomId)).toEqual({ ok: true });
    expect(latestState(states)).toEqual(deserializeGameState(initial));
    expect(server.getRoom(roomId)!.state).toBe("playing"); // rematch-ready

    // And the players can keep playing afterwards.
    expect(aimAtCenter(server, sessions[0])).toEqual({ ok: true });
  });

  it("resetMatch fails cleanly without a running match", () => {
    const server = newServer();
    const { roomId } = makeRoom(server, 2);
    expect(server.resetMatch(roomId)).toEqual({ ok: false, reason: "no-match" });
    expect(server.resetMatch("no-such-room")).toEqual({
      ok: false,
      reason: "unknown-room",
    });
    expect(server.resetMatch(null)).toEqual({ ok: false, reason: "unknown-room" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Multiple simultaneous rooms
// ────────────────────────────────────────────────────────────────────────

describe("multiple simultaneous rooms", () => {
  it("rooms run independent matches", () => {
    const server = newServer();
    const roomA = makeRoom(server, 2);
    const roomB = makeRoom(server, 3);
    expect(roomA.roomId).not.toBe(roomB.roomId);
    expect(server.roomCount()).toBe(2);

    const statesA = statePipe(server, roomA.sessions[0]);
    const statesB = statePipe(server, roomB.sessions[0]);
    server.startMatch(roomA.roomId);
    server.startMatch(roomB.roomId);

    // Different rosters.
    expect(latestState(statesA).pawns).toHaveLength(2);
    expect(latestState(statesB).pawns).toHaveLength(3);

    // Commands in room A do not touch room B.
    server.submitCommand(roomA.sessions[0], {
      type: "aim",
      playerId: "p9", // forged — ignored in room A, invisible in room B
      x: CX + 120,
      y: CY,
    });
    const a = latestState(statesA);
    const b = latestState(statesB);
    expect(a.pawns[0].aim.active).toBe(true);
    expect(b.pawns[0].aim.active).toBe(false);
    expect(b.pawns[0].power).toBe(CONFIG.power.default);

    // Room A's session cannot act in room B — it has no seat there.
    expect(server.submitCommand(roomA.sessions[1], { type: "reset" })).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    expect(aimAtCenter(server, roomB.sessions[0])).toEqual({ ok: true }); // p0 of room B, whose turn it is
  });

  it("emptying one room leaves the others untouched", () => {
    const server = newServer();
    const roomA = makeRoom(server, 2);
    const roomB = makeRoom(server, 2);
    server.startMatch(roomA.roomId);
    server.startMatch(roomB.roomId);

    for (const s of roomA.sessions) server.disconnect(s);
    expect(server.getRoom(roomA.roomId)).toBeNull();
    expect(server.roomCount()).toBe(1);
    expect(server.getRoom(roomB.roomId)!.state).toBe("playing");
    expect(aimAtCenter(server, roomB.sessions[0])).toEqual({ ok: true });
  });
});

// ────────────────────────────────────────────────────────────────────────
// The broadcast hook
// ────────────────────────────────────────────────────────────────────────

describe("onRoomState (the transport broadcast hook)", () => {
  it("pushes match state to seated sessions only, from match start on", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const p0: string[] = [];
    const p1: string[] = [];
    const outside: string[] = [];
    const unsubOutside = server.onRoomState(server.connect(), (s) => outside.push(s));

    // While waiting there is no match state yet.
    server.onRoomState(sessions[0], (s) => p0.push(s));
    expect(p0).toHaveLength(0);

    server.startMatch(roomId); // → initial push
    expect(p0).toHaveLength(1);
    expect(outside).toHaveLength(0); // roomless sessions hear nothing

    // Late subscribers get the current snapshot immediately.
    server.onRoomState(sessions[1], (s) => p1.push(s));
    expect(p1).toEqual([p0[p0.length - 1]]);

    server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY });
    expect(p0).toHaveLength(2);
    expect(p1).toHaveLength(2);

    // Leaving stops the broadcast for that session.
    server.leaveRoom(sessions[1]);
    server.submitCommand(sessions[0], { type: "setPower", power: 2 });
    expect(p0).toHaveLength(3);
    expect(p1).toHaveLength(2); // no longer pushed
    unsubOutside();
  });

  it("isolates broadcasts per room", () => {
    const server = newServer();
    const roomA = makeRoom(server, 2);
    const roomB = makeRoom(server, 2);
    const a: string[] = [];
    const b: string[] = [];
    server.onRoomState(roomA.sessions[0], (s) => a.push(s));
    server.onRoomState(roomB.sessions[0], (s) => b.push(s));
    server.startMatch(roomB.roomId);
    expect(b).toHaveLength(1);
    expect(a).toHaveLength(0); // room A never started
  });
});
