import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, deserializeGameState, type GameState } from "../../game";
import {
  createGameServer,
  MAX_PLAYERS,
  type GameServer,
  type Session,
} from "../index";

/**
 * REMATCH — staying in the room after a match ends (Task 25).
 *
 * The room already SURVIVED a match end before this task: nothing
 * destroys it on "finished" (only an empty room is removed, Task 18).
 * What was missing was a way back: `startMatch` refused a finished room
 * with "already-playing", and the client's only post-match action was to
 * leave. These tests pin the way back, and — just as importantly — pin
 * the things that must NOT change with it:
 *
 *   - the room, its code, its seats and its players survive the match;
 *   - a finished room returns to "waiting" and plays again through the
 *     EXISTING startMatch (no second start mechanism);
 *   - leaving after a match still runs the normal leave path: the seat is
 *     released, and the room is destroyed only when genuinely empty;
 *   - a post-match public room at capacity is never handed a stranger by
 *     matchmaking (Task 17 policy, unchanged), but becomes joinable again
 *     the moment a returning player actually leaves;
 *   - a match still RUNNING cannot be reopened — "already-playing" keeps
 *     its original meaning.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── helpers ───────────────────────────────────────────────────────────────

const liveServers: GameServer[] = [];
function newServer(): GameServer {
  const server = createGameServer({ randomSkinIndex: () => 0 });
  liveServers.push(server);
  return server;
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

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

/**
 * Play a REAL match to a real winner: every player but the last launches
 * itself radially over the rim at full power, the last never chooses, and
 * the server's own loop decides the match. Deliberately the same
 * technique roomManager.test.ts uses (extended from 2 players to N), so
 * this is the genuine end-of-match path — no state is hand-forced.
 *
 * Returns the winner id the server settled on: always the last session.
 */
async function playToFinish(
  server: GameServer,
  roomId: string,
  sessions: Session[],
  states: string[]
): Promise<string | null> {
  const pawns = latestState(states).pawns;
  // Everyone except the final seat knocks themselves out this round.
  for (let i = 0; i < sessions.length - 1; i++) {
    const pawn = pawns.find((p) => p.id === `p${i}`);
    if (!pawn || pawn.eliminated) continue;
    const dx = pawn.position.x - CX || 1;
    const dy = pawn.position.y - CY;
    const len = Math.hypot(dx, dy) || 1;
    server.submitCommand(sessions[i]!, {
      type: "aim",
      x: CX + (dx / len) * 400,
      y: CY + (dy / len) * 400,
    });
    server.submitCommand(sessions[i]!, { type: "setPower", power: 5 });
    server.submitCommand(sessions[i]!, { type: "confirmLaunch" });
  }
  expect(server.resolveRound(roomId)).toEqual({ ok: true });

  const finished = await waitFor(
    () => server.getRoom(roomId)!.state === "finished",
    8000
  );
  expect(finished).toBe(true);
  return latestState(states).winnerId;
}

// ────────────────────────────────────────────────────────────────────────
// The room survives the match
// ────────────────────────────────────────────────────────────────────────

describe("the room and its players survive a finished match", () => {
  it("keeps the same room id, code and seated players after the match ends", async () => {
    const server = newServer();
    const { roomId, sessions, playerIds } = makeRoom(server, 2);
    server.setName(sessions[0]!, "Ada");
    server.setName(sessions[1]!, "Grace");
    const before = server.getRoom(roomId)!;
    const codeBefore = before.code;
    const hostBefore = before.hostPlayerId;

    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    // Same room object, by identity as far as the API can express it.
    const after = server.getRoom(roomId)!;
    expect(after).not.toBeNull();
    expect(after.id).toBe(roomId);
    expect(after.code).toBe(codeBefore);
    expect(after.state).toBe("finished");
    expect(server.roomCount()).toBe(1);

    // Both players are still seated, still named, still themselves.
    expect(after.seats.map((p) => p.playerId)).toEqual(playerIds);
    expect(after.seats.map((p) => p.displayName)).toEqual(["Ada", "Grace"]);
    expect(after.seats.every((p) => p.connected)).toBe(true);
    expect(after.hostPlayerId).toBe(hostBefore);

    // And the seats still resolve from the very same sessions.
    expect(server.getSeat(sessions[0]!)!.playerId).toBe(playerIds[0]);
    expect(server.getSeat(sessions[1]!)!.playerId).toBe(playerIds[1]);
  }, 15000);

  it("does not destroy a finished room during empty-room cleanup", async () => {
    // Task 18's sweeper removes EMPTY rooms. A finished room full of
    // players is not empty, and must be left alone.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.removeEmptyRooms()).toBe(0);
    expect(server.getRoom(roomId)).not.toBeNull();
  }, 15000);
});

// ────────────────────────────────────────────────────────────────────────
// Back to waiting, and into a second match via the EXISTING startMatch
// ────────────────────────────────────────────────────────────────────────

describe("a finished room returns to waiting and plays again", () => {
  it("returnToLobby moves finished → waiting, keeping room and seats", async () => {
    const server = newServer();
    const { roomId, sessions, playerIds } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);
    expect(server.getRoom(roomId)!.state).toBe("finished");

    const result = server.returnToLobby(roomId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.room.state).toBe("waiting");
    expect(result.room.id).toBe(roomId);
    expect(result.room.seats.map((p) => p.playerId)).toEqual(playerIds);
    expect(server.getRoom(roomId)!.state).toBe("waiting");
  }, 15000);

  it("plays a SECOND match through the existing startMatch", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);

    server.startMatch(roomId);
    const firstWinner = await playToFinish(server, roomId, sessions, states);
    expect(firstWinner).toBe("p1");

    expect(server.returnToLobby(roomId).ok).toBe(true);

    // The SAME entry point starts the rematch — no new mechanism.
    const second = server.startMatch(roomId);
    expect(second.ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");

    // And it is a genuinely fresh match: everyone alive again, round 1.
    const fresh = latestState(states);
    expect(fresh.phase).not.toBe("finished");
    expect(fresh.winnerId).toBeNull();
    expect(fresh.pawns).toHaveLength(2);
    expect(fresh.pawns.every((p) => !p.eliminated)).toBe(true);

    // Played to the end a second time, it produces a verdict again.
    const secondWinner = await playToFinish(server, roomId, sessions, states);
    expect(secondWinner).toBe("p1");
    expect(server.getRoom(roomId)!.state).toBe("finished");
  }, 25000);

  it("startMatch alone reopens a finished room (no returnToLobby needed)", async () => {
    // The host pressing Start on a finished room is a legitimate rematch
    // too — reopening is folded into startMatch itself, which is what
    // lets the pre-match lobby reuse its existing button unchanged.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  }, 15000);

  it("still refuses to restart a match that is RUNNING", () => {
    // The pre-existing guard keeps its exact meaning: only "finished"
    // reopens, never "playing".
    const server = newServer();
    const { roomId } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.startMatch(roomId)).toEqual({
      ok: false,
      reason: "already-playing",
    });
    expect(server.returnToLobby(roomId)).toEqual({
      ok: false,
      reason: "already-playing",
    });
    expect(server.getRoom(roomId)!.state).toBe("playing");
  });

  it("returnToLobby is idempotent on a waiting room and unknown-room safe", () => {
    // Two players clicking Play again at once must both get a clean
    // answer rather than one of them seeing an error.
    const server = newServer();
    const { roomId } = makeRoom(server, 2);
    const first = server.returnToLobby(roomId);
    const second = server.returnToLobby(roomId);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("waiting");

    for (const bad of ["no-such-room", null, undefined, 42, {}]) {
      expect(server.returnToLobby(bad)).toEqual({
        ok: false,
        reason: "unknown-room",
      });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Leaving after a match — the unchanged leave path
// ────────────────────────────────────────────────────────────────────────

describe("leaving after a match still uses the normal leave path", () => {
  it("releases the seat and leaves the room alive for whoever stays", async () => {
    const server = newServer();
    const { roomId, sessions, playerIds } = makeRoom(server, 3);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    const left = server.leaveRoom(sessions[2]!);
    expect(left.ok).toBe(true);

    // detachSeat is UNCHANGED, so the pre-existing frozen-roster rule
    // still applies: a room that is not "waiting" keeps the departed
    // seat listed as disconnected rather than deleting it mid-match.
    // The seat itself is genuinely released — the session no longer
    // resolves to one — and the reopen below is what actually reclaims
    // it (see "frees their seat for the rematch").
    const room = server.getRoom(roomId)!;
    expect(room).not.toBeNull();
    expect(room.seats.map((p) => p.playerId)).toEqual(playerIds);
    expect(room.seats.map((p) => p.connected)).toEqual([true, true, false]);
    expect(server.getSeat(sessions[2]!)).toBeNull();

    // Reopening for the rematch drops the ghost from the roster.
    expect(server.returnToLobby(roomId).ok).toBe(true);
    const reopened = server.getRoom(roomId)!;
    expect(reopened.seats.map((p) => p.playerId)).toEqual(playerIds.slice(0, 2));
    expect(reopened.seats.every((p) => p.connected)).toBe(true);
  }, 15000);

  it("destroys the room only once the LAST player leaves", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)).not.toBeNull(); // one player remains

    expect(server.leaveRoom(sessions[1]!).ok).toBe(true);
    expect(server.getRoom(roomId)).toBeNull(); // genuinely empty now
    expect(server.roomCount()).toBe(0);
  }, 15000);

  it("a player who leaves post-match frees their seat for the rematch", async () => {
    // Seats abandoned during a match are held out of the free list while
    // the match runs; reopening must give them back, or a room would
    // shrink by one every match.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.leaveRoom(sessions[2]!).ok).toBe(true);
    expect(server.returnToLobby(roomId).ok).toBe(true);

    // A newcomer can take the freed seat in the reopened lobby.
    const newcomer = server.connect();
    const joined = server.joinRoom(newcomer, roomId);
    expect(joined.ok).toBe(true);
    expect(server.getRoom(roomId)!.seats).toHaveLength(3);
  }, 15000);
});

// ────────────────────────────────────────────────────────────────────────
// Edge cases in the post-match window
// ────────────────────────────────────────────────────────────────────────

describe("edge cases around the rematch", () => {
  it("keeps a RESERVED (dropped) seat through the reopen so it can recover", async () => {
    // A player who drops during the result screen holds a reserved seat.
    // Reopening must not repurpose it — their reconnect window is still
    // open and the seat is still theirs.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.reserve(sessions[2]!).ok).toBe(true);
    expect(server.returnToLobby(roomId).ok).toBe(true);

    // Still listed, still theirs, reported disconnected while away.
    const room = server.getRoom(roomId)!;
    expect(room.seats.map((p) => p.playerId)).toEqual(["p0", "p1", "p2"]);
    expect(room.seats.find((p) => p.playerId === "p2")!.connected).toBe(false);
    expect(server.getSeat(sessions[2]!)!.playerId).toBe("p2");
  }, 15000);

  it("promotes a new host when the creator leaves after a match", async () => {
    // UPDATED (Task 26). This previously asserted the room was left
    // hostless — the exact "stuck room" bug, and the one thing that could
    // block a rematch. Succession now fixes it: the group can play again
    // without the creator. Host identity is still per-player rather than
    // per-match; reopening does not reshuffle it (see the next test).
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");
    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);

    // Promoted immediately on leaving — not deferred to the reopen.
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");

    expect(server.returnToLobby(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("waiting");
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");

    // And the promotion is real authority: the rematch actually starts.
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  }, 15000);

  it("keeps the host across a rematch while the creator stays", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.returnToLobby(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");
  }, 15000);

  it("refuses a rematch that no longer has enough players", async () => {
    // Two played, one left: the reopened room is a normal waiting room
    // with one seat, and the existing MIN_PLAYERS rule applies untouched.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    expect(server.leaveRoom(sessions[1]!).ok).toBe(true);
    expect(server.returnToLobby(roomId).ok).toBe(true);
    const started = server.startMatch(roomId);
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    expect(started.reason).toBe("not-enough-players");
  }, 15000);
});

// ────────────────────────────────────────────────────────────────────────
// Matchmaking: no stranger in an occupied post-match room (Task 17)
// ────────────────────────────────────────────────────────────────────────

describe("public matchmaking and post-match rooms", () => {
  /** A public room filled to capacity through matchmaking itself. */
  function makeFullPublicRoom(server: GameServer) {
    const sessions: Session[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const s = server.connect();
      const joined = server.joinPublicRoom(s);
      expect(joined.ok).toBe(true);
      sessions.push(s);
    }
    const roomId = server.getSeat(sessions[0]!)!.room.id;
    // Everyone landed in the SAME room — otherwise the test proves nothing.
    for (const s of sessions) {
      expect(server.getSeat(s)!.room.id).toBe(roomId);
    }
    return { roomId, sessions };
  }

  it("never matches a stranger into a FULL post-match room", async () => {
    const server = newServer();
    const { roomId, sessions } = makeFullPublicRoom(server);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);

    // Back to waiting for a rematch — and still full.
    expect(server.returnToLobby(roomId).ok).toBe(true);
    const room = server.getRoom(roomId)!;
    expect(room.state).toBe("waiting");
    expect(room.seats).toHaveLength(MAX_PLAYERS);

    // Quick-play must NOT drop the stranger into these players' rematch.
    const stranger = server.connect();
    const matched = server.joinPublicRoom(stranger);
    expect(matched.ok).toBe(true);
    if (!matched.ok) throw new Error("unreachable");
    expect(matched.room.id).not.toBe(roomId);
    expect(server.getRoom(roomId)!.seats).toHaveLength(MAX_PLAYERS);
  }, 25000);

  it("matches a stranger in once a returning player frees a seat", async () => {
    const server = newServer();
    const { roomId, sessions } = makeFullPublicRoom(server);
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);
    expect(server.returnToLobby(roomId).ok).toBe(true);

    // One player is done for the night and leaves properly.
    expect(server.leaveRoom(sessions[MAX_PLAYERS - 1]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.seats).toHaveLength(MAX_PLAYERS - 1);

    // NOW quick-play may fill the vacancy — same room, no new one.
    const stranger = server.connect();
    const matched = server.joinPublicRoom(stranger);
    expect(matched.ok).toBe(true);
    if (!matched.ok) throw new Error("unreachable");
    expect(matched.room.id).toBe(roomId);
    expect(server.getRoom(roomId)!.seats).toHaveLength(MAX_PLAYERS);
  }, 25000);

  it("never matches anyone into a room whose match is still finished-but-unreopened", async () => {
    // Before anyone presses Play again the room is "finished", which
    // matchmaking has always skipped. Pinned so reopening cannot
    // accidentally widen the pool.
    const server = newServer();
    const sessions: Session[] = [];
    for (let i = 0; i < 2; i++) {
      const s = server.connect();
      expect(server.joinPublicRoom(s).ok).toBe(true);
      sessions.push(s);
    }
    const roomId = server.getSeat(sessions[0]!)!.room.id;
    const states = statePipe(server, sessions[0]!);
    server.startMatch(roomId);
    await playToFinish(server, roomId, sessions, states);
    expect(server.getRoom(roomId)!.state).toBe("finished");

    const stranger = server.connect();
    const matched = server.joinPublicRoom(stranger);
    expect(matched.ok).toBe(true);
    if (!matched.ok) throw new Error("unreachable");
    expect(matched.room.id).not.toBe(roomId);
  }, 15000);
});
