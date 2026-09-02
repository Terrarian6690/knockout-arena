import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  projectSnapshot,
  type GameState,
} from "../../game";
import { createGameServer, type GameServer, type SeatedResult } from "../index";
import type { Session } from "../session";

/**
 * Seat recovery at the game-server facade level (no sockets): credentials,
 * reservations, expiry and identity preservation across reconnects.
 *
 * The wire/transport behavior (welcome contents, takeover kicks, the
 * reconnect message) lives in reconnect.transport.test.ts; the browser
 * client's behavior lives in the client tests. What these tests pin:
 *
 *   - taking a seat issues an opaque per-seat credential (returned ONLY
 *     to that player — never in RoomInfo, snapshots or broadcasts);
 *   - reserve() opens a reconnect window: the seat stays occupied and
 *     unstealable, reported disconnected, room alive;
 *   - reconnect(credential) reclaims the SAME seat — same session, same
 *     playerId, same live match state — waiting or playing, on turn or
 *     eliminated;
 *   - credentials are revoked with the seat (leave / disconnect / expiry);
 *   - every failure is the SAME indistinguishable "invalid-reconnect";
 *   - expiry applies the normal leave rules (seat freed/vacated, room
 *     cleaned up if empty, match state untouched).
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── helpers ───────────────────────────────────────────────────────────────

const liveServers: GameServer[] = [];
function newServer(options?: { reconnectReservationMs?: number }): GameServer {
  const server = createGameServer(options);
  liveServers.push(server);
  return server;
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function okSeat(result: SeatedResult): {
  roomId: string;
  playerId: string;
  reconnectToken: string;
} {
  if (!result.ok) throw new Error(`seat failed: ${result.reason}`);
  return {
    roomId: result.room.id,
    playerId: result.playerId,
    reconnectToken: result.reconnectToken,
  };
}

/** A waiting room with n seated sessions; returns their credentials. */
function makeRoom(
  server: GameServer,
  n: number
): {
  roomId: string;
  sessions: Session[];
  tokens: string[];
} {
  const sessions: Session[] = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = okSeat(server.createRoom(creator));
  sessions.push(creator);
  tokens.push(created.reconnectToken);
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = okSeat(server.joinRoom(s, created.roomId));
    sessions.push(s);
    tokens.push(joined.reconnectToken);
  }
  return { roomId: created.roomId, sessions, tokens };
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

/** The active pawn of the latest state (spectator projection). */
function activePawnId(received: string[]): string | null {
  return projectSnapshot(latestState(received), null).activePawnId;
}

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

/** Radially outward target: a p5 launch from `pawn` flies over the rim. */
function overTheRim(pawn: { position: { x: number; y: number } }): {
  x: number;
  y: number;
} {
  const dx = pawn.position.x - CX || 1;
  const dy = pawn.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  return { x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 };
}

// ────────────────────────────────────────────────────────────────────────
// Credentials — issued with the seat, opaque, single-player
// ────────────────────────────────────────────────────────────────────────

describe("reconnect credentials", () => {
  it("create_room and join_room issue an opaque credential per seat", () => {
    const server = newServer();
    const { sessions, tokens } = makeRoom(server, 2);

    expect(tokens[0]).toBeTruthy();
    expect(tokens[1]).toBeTruthy();
    // Opaque: not derived from identity anyone else can see.
    expect(tokens[0]).not.toBe(tokens[1]);
    for (const token of tokens) {
      expect(token).not.toContain("p0");
      expect(token).not.toContain(sessions[0].token);
    }
    // Not a playerId, not a roomId — a credential is its own thing and is
    // never accepted as one (the room's public info carries nothing).
    const room = server.getRoom(
      okSeat(server.createRoom(server.connect())).roomId
    )!;
    expect(JSON.stringify(room)).not.toContain(tokens[0]);
  });

  it("reserve() keeps the seat occupied but reported disconnected", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    const room = server.getRoom(roomId)!;
    expect(room.seats).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: false }, // reserved, not vacated
    ]);
    expect(room.state).toBe("waiting");
    expect(server.sessionCount()).toBe(2); // identity preserved
    expect(tokens).toHaveLength(2);
  });

  it("reserve() on an unseated session fails (nothing to reserve)", () => {
    const server = newServer();
    const session = server.connect();
    expect(server.reserve(session)).toEqual({ ok: false, reason: "not-in-room" });
  });

  it("disconnect() is the force path: the credential dies with the seat", () => {
    const server = newServer();
    const { sessions, tokens } = makeRoom(server, 2);

    expect(server.disconnect(sessions[1])).toBe(true);
    expect(server.reconnect(tokens[1])).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
  });

  it("leaveRoom() revokes the credential (the seat is gone)", () => {
    const server = newServer();
    const { sessions, tokens } = makeRoom(server, 2);

    expect(server.leaveRoom(sessions[1]).ok).toBe(true);
    expect(server.reconnect(tokens[1])).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reclaiming a seat — same identity, waiting or playing
// ────────────────────────────────────────────────────────────────────────

describe("seat recovery", () => {
  it("the creator recovers its seat: same room, playerId and session", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);

    expect(server.reserve(sessions[0])).toEqual({ ok: true });
    const recovered = server.reconnect(tokens[0]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.room.id).toBe(roomId);
    expect(recovered.playerId).toBe("p0");
    expect(recovered.session).toBe(sessions[0]); // SAME identity object
    expect(recovered.reconnectToken).toBe(tokens[0]); // persistent credential
    expect(server.getRoom(roomId)!.seats).toEqual([
      { playerId: "p0", connected: true }, // reservation cancelled
      { playerId: "p1", connected: true },
    ]);
    expect(server.sessionCount()).toBe(2); // no duplicate identity
  });

  it("a joiner recovers its seat the same way (p1)", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 3);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.room.id).toBe(roomId);
    expect(recovered.playerId).toBe("p1");
    expect(recovered.session).toBe(sessions[1]);
  });

  it("a reserved seat is not stealable: joiners take LATER seats", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });

    // A fresh session joins while p1's seat is reserved: it must get p2,
    // never the reserved p1.
    const newcomer = server.connect();
    const joined = okSeat(server.joinRoom(newcomer, roomId));
    expect(joined.playerId).toBe("p2");

    // And the reserved player still recovers p1 afterwards.
    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.playerId).toBe("p1");
    expect(server.getRoom(roomId)!.seats).toHaveLength(3); // no duplicates
  });

  it("mid-match recovery: same seat, same live match — nothing restarts", async () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    // Some play happens, then p1's connection drops mid-match.
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY })
    ).toEqual({ ok: true });
    expect(await waitFor(() => states.length > 1, 3000)).toBe(true);
    const stateBefore = latestState(states);
    expect(server.reserve(sessions[1])).toEqual({ ok: true });

    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.playerId).toBe("p1");
    expect(recovered.room.id).toBe(roomId);

    // The match was never restarted: same room, still playing, and the
    // authoritative state is exactly the pre-drop one (no command was
    // applied while the seat was reserved).
    const room = server.getRoom(roomId)!;
    expect(room.state).toBe("playing");
    expect(room.seats).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: true },
    ]);
    expect(latestState(states)).toEqual(stateBefore);

    // The recovered player's commands work again immediately.
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: CX, y: CY })
    ).toEqual({
      ok: false,
      reason: "wrong-player", // not their turn — identity-aware as always
    });
  }, 8000);

  it("dropping on your own turn: it is still your turn after recovery", async () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    // p0 plays a short inward shot → the turn passes to p1.
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY })
    ).toEqual({ ok: true });
    expect(server.submitCommand(sessions[0], { type: "setPower", power: 1 })).toEqual({
      ok: true,
    });
    expect(server.submitCommand(sessions[0], { type: "confirmLaunch" })).toEqual({
      ok: true,
    });
    expect(await waitFor(() => activePawnId(states) === "p1", 5000)).toBe(true);

    // p1 drops on its own turn and recovers: still p1's turn.
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    expect(activePawnId(states)).toBe("p1");
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: CX, y: CY })
    ).toEqual({ ok: true }); // their turn, they can aim again
  }, 10000);

  it("dropping after elimination: still eliminated after recovery", async () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    // p0 plays a short inward shot to hand the turn to p1.
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: CX, y: CY })
    ).toEqual({ ok: true });
    expect(server.submitCommand(sessions[0], { type: "setPower", power: 1 })).toEqual({
      ok: true,
    });
    expect(server.submitCommand(sessions[0], { type: "confirmLaunch" })).toEqual({
      ok: true,
    });
    expect(await waitFor(() => activePawnId(states) === "p1", 5000)).toBe(true);

    // p1 eliminates itself: radial outward p5 launch over the rim.
    const target = overTheRim(latestState(states).pawns[1]);
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: target.x, y: target.y })
    ).toEqual({ ok: true });
    expect(server.submitCommand(sessions[1], { type: "setPower", power: 5 })).toEqual({
      ok: true,
    });
    expect(server.submitCommand(sessions[1], { type: "confirmLaunch" })).toEqual({
      ok: true,
    });
    expect(
      await waitFor(
        () => latestState(states).pawns[1].eliminated === true,
        5000
      )
    ).toBe(true);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    const recovered = server.reconnect(tokens[1]);
    expect(recovered.ok).toBe(true);
    expect(latestState(states).pawns[1].eliminated).toBe(true);
    // Still eliminated — and the match is over (p0 won): the recovered
    // identity gets the normal rejection, never a new turn.
    expect(latestState(states).phase).toBe("finished");
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: CX, y: CY })
    ).toEqual({ ok: false, reason: "wrong-phase" });
  }, 10000);

  it("concurrent same-credential reconnects create no duplicate seats", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    const first = server.reconnect(tokens[1]);
    const second = server.reconnect(tokens[1]); // a racing second socket
    for (const result of [first, second]) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.playerId).toBe("p1");
      expect(result.session).toBe(sessions[1]);
    }
    // One seat, one player, one identity — nothing duplicated.
    const room = server.getRoom(roomId)!;
    expect(room.seats).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: true },
    ]);
    expect(server.sessionCount()).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Rejection — uniform, no information leak
// ────────────────────────────────────────────────────────────────────────

describe("credential rejection", () => {
  it("garbage, empty, non-string and foreign credentials are all rejected alike", () => {
    const server = newServer();
    makeRoom(server, 2);
    const invalid: unknown[] = [
      "",
      "not-a-real-credential",
      "p0", // a playerId is never a credential
      "p1",
      123,
      null,
      undefined,
      {},
      [],
      "0".repeat(64),
    ];
    for (const token of invalid) {
      expect(server.reconnect(token)).toEqual({
        ok: false,
        reason: "invalid-reconnect",
      });
    }
  });

  it("a credential never claims another player's seat", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 3);

    // p2's credential recovers p2 — even while p0 is (briefly) reserved.
    expect(server.reserve(sessions[0])).toEqual({ ok: true });
    const recovered = server.reconnect(tokens[2]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.playerId).toBe("p2"); // its own seat, nobody else's
    expect(recovered.room.id).toBe(roomId);
    expect(server.getRoom(roomId)!.seats[0]).toEqual({
      playerId: "p0",
      connected: false, // p0's reservation is untouched
    });
  });

  it("a revoked-room credential (server teardown) is rejected", () => {
    const server = newServer();
    const { tokens } = makeRoom(server, 1);
    server.destroy();
    expect(server.reconnect(tokens[0])).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Expiry — the normal leave rules, applied late
// ────────────────────────────────────────────────────────────────────────

describe("reservation expiry", () => {
  it("an expired credential is rejected — and the waiting seat is freed for joiners", async () => {
    const server = newServer({ reconnectReservationMs: 40 });
    const { roomId, sessions, tokens } = makeRoom(server, 2);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    expect(await waitFor(() => server.sessionCount() === 1, 3000)).toBe(true);

    // The credential no longer works…
    expect(server.reconnect(tokens[1])).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
    // …and the seat was released with the normal leave rules: a fresh
    // session can take p1's place.
    const newcomer = server.connect();
    expect(okSeat(server.joinRoom(newcomer, roomId)).playerId).toBe("p1");
    expect(server.getRoom(roomId)!.seats).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: true },
    ]);
  });

  it("an emptied reserved room is destroyed on expiry", async () => {
    const server = newServer({ reconnectReservationMs: 40 });
    const { roomId, sessions } = makeRoom(server, 1);

    expect(server.reserve(sessions[0])).toEqual({ ok: true });
    expect(server.getRoom(roomId)).not.toBeNull(); // reserved rooms live
    expect(await waitFor(() => server.sessionCount() === 0, 3000)).toBe(true);
    expect(server.getRoom(roomId)).toBeNull(); // empty → removed
    expect(server.roomCount()).toBe(0);
  });

  it("mid-match expiry vacates the seat; the match state stays valid", async () => {
    const server = newServer({ reconnectReservationMs: 40 });
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    expect(await waitFor(() => server.sessionCount() === 1, 3000)).toBe(true);

    // The roster is frozen (vacated seat, disconnected) and the match is
    // untouched — no restart, still playing, state observable.
    const room = server.getRoom(roomId)!;
    expect(room.state).toBe("playing");
    expect(room.seats).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: false },
    ]);
    expect(states.length).toBeGreaterThan(0);
    expect(() => latestState(states)).not.toThrow();
    expect(latestState(states).phase).not.toBe("finished");

    // And the expired credential is dead.
    expect(server.reconnect(tokens[1])).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
  }, 8000);

  it("a reserved seat keeps an otherwise-empty waiting room alive", async () => {
    const server = newServer({ reconnectReservationMs: 500 });
    const { roomId, sessions } = makeRoom(server, 2);

    // Both drop: both seats reserved → the room survives the window.
    expect(server.reserve(sessions[0])).toEqual({ ok: true });
    expect(server.reserve(sessions[1])).toEqual({ ok: true });
    expect(server.removeEmptyRooms()).toBe(0); // reserved seats are occupied
    expect(server.getRoom(roomId)).not.toBeNull();
    expect(await waitFor(() => server.sessionCount() === 0, 3000)).toBe(true);
    expect(server.getRoom(roomId)).toBeNull();
  });

  it("re-reserving restarts the window (a flapping connection)", async () => {
    const server = newServer({ reconnectReservationMs: 80 });
    const { sessions, tokens } = makeRoom(server, 1);

    expect(server.reserve(sessions[0])).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 40)); // half the window
    expect(server.reserve(sessions[0])).toEqual({ ok: true }); // restart
    await new Promise((r) => setTimeout(r, 50)); // past the FIRST window
    expect(server.reconnect(tokens[0]).ok).toBe(true); // still valid
  });
});
