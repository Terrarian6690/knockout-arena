import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, deserializeGameState, type GameState } from "../../game";
import {
  createGameServer,
  MAX_PLAYERS,
  type GameServer,
  type Session,
} from "../index";

/**
 * HOST SUCCESSION (Task 26).
 *
 * Before this task a room's host was permanently the creator: hostToken
 * was set once and hostPlayerId derived from `seats.indexOf(hostToken)`,
 * so the moment the creator's seat emptied the room reported no host —
 * and since start_match is host-only, the remaining players were stuck
 * in a room they could never start a match in.
 *
 * THE RULE: promote the LOWEST OCCUPIED SEAT INDEX. Seats are handed out
 * in ascending order and never renumbered, so the lowest occupied index
 * is the earliest-joined player still present. It is deterministic, a
 * pure function of current state, and needs no extra bookkeeping.
 *
 * What these tests pin:
 *   - succession on leave, deterministically, with full authority;
 *   - succession when a reconnect window EXPIRES (a real departure);
 *   - NO succession while a dropped host is still inside their window
 *     (Tasks 13-15 untouched — they are coming back);
 *   - succession in every room state: waiting, playing, and the Task 25
 *     post-match lobby;
 *   - an empty room is still destroyed rather than succeeded (Task 18).
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

/** A room with n seated sessions (creator first), plus their credentials. */
function makeRoom(
  server: GameServer,
  n: number
): {
  roomId: string;
  sessions: Session[];
  playerIds: string[];
  tokens: string[];
} {
  const sessions: Session[] = [];
  const playerIds: string[] = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  if (!created.ok) throw new Error("create failed");
  sessions.push(creator);
  playerIds.push(created.playerId);
  tokens.push(created.reconnectToken);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, roomId);
    if (!joined.ok) throw new Error("join failed");
    sessions.push(s);
    playerIds.push(joined.playerId);
    tokens.push(joined.reconnectToken);
  }
  return { roomId, sessions, playerIds, tokens };
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Play the running match to a winner (everyone but the last seat exits). */
async function playToFinish(
  server: GameServer,
  roomId: string,
  sessions: Session[],
  states: string[]
): Promise<void> {
  const pawns = latestState(states).pawns;
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
  server.resolveRound(roomId);
  const finished = await waitFor(
    () => server.getRoom(roomId)!.state === "finished",
    8000
  );
  expect(finished).toBe(true);
}

// ────────────────────────────────────────────────────────────────────────
// The rule
// ────────────────────────────────────────────────────────────────────────

describe("the host is replaced when their seat empties", () => {
  it("promotes the lowest occupied seat when the creator leaves", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");

    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);

    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
  });

  it("skips seats that are already empty — lowest OCCUPIED, not lowest", () => {
    // p1 leaves first, so when the host goes the successor is p2: the
    // rule is about who is actually there, not about seat numbering.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    expect(server.leaveRoom(sessions[1]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0"); // unaffected

    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p2");
  });

  it("is deterministic — the same departures always pick the same host", () => {
    // Run the identical scenario repeatedly; a random or arbitrary rule
    // would eventually disagree with itself.
    for (let run = 0; run < 5; run++) {
      const server = newServer();
      const { roomId, sessions } = makeRoom(server, 4);
      server.leaveRoom(sessions[0]!);
      expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
      server.leaveRoom(sessions[1]!);
      expect(server.getRoom(roomId)!.hostPlayerId).toBe("p2");
    }
  });

  it("does not disturb the host when a NON-host leaves", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    expect(server.leaveRoom(sessions[2]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");
    expect(server.leaveRoom(sessions[1]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");
  });

  it("chains: each successive host leaving promotes the next player", () => {
    // The edge case worth naming — host leaves, the new host immediately
    // leaves too. Succession is stateless, so it simply repeats.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 4);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");
    server.leaveRoom(sessions[0]!);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    server.leaveRoom(sessions[1]!);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p2");
    server.leaveRoom(sessions[2]!);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p3");
    // The last player standing is the host, and can still start nothing
    // alone — MIN_PLAYERS is a separate, untouched rule.
    const started = server.startMatch(roomId);
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    expect(started.reason).toBe("not-enough-players");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Real authority, not a label
// ────────────────────────────────────────────────────────────────────────

describe("the promoted host has the original host's authority", () => {
  it("can start a match; the room actually plays", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    server.leaveRoom(sessions[0]!);

    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  });

  it("reports exactly one host — the room is never ambiguous", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 4);
    server.leaveRoom(sessions[0]!);
    const room = server.getRoom(roomId)!;
    const host = room.hostPlayerId;
    expect(host).not.toBeNull();
    // The host is a real, currently seated player.
    expect(room.seats.map((s) => s.playerId)).toContain(host);
  });

  it("an occupied room always has a host, however players churn", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 4);
    for (const session of [sessions[0]!, sessions[2]!, sessions[1]!]) {
      server.leaveRoom(session);
      const room = server.getRoom(roomId);
      if (room === null) break;
      expect(room.hostPlayerId).not.toBeNull();
      expect(room.seats.map((s) => s.playerId)).toContain(room.hostPlayerId);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reconnect window: no premature succession (Tasks 13-15 unchanged)
// ────────────────────────────────────────────────────────────────────────

describe("a dropped host inside their reconnect window stays host", () => {
  it("keeps the host while the seat is merely reserved", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);

    // The host's connection drops: the seat is reserved, not released.
    expect(server.reserve(sessions[0]!).ok).toBe(true);

    const room = server.getRoom(roomId)!;
    expect(room.hostPlayerId).toBe("p0"); // no succession
    // Reported disconnected, but still their seat.
    expect(room.seats.find((s) => s.playerId === "p0")!.connected).toBe(false);
  });

  it("resumes as host after reconnecting within the window", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 3);
    expect(server.reserve(sessions[0]!).ok).toBe(true);

    const recovered = server.reconnect(tokens[0]!);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.playerId).toBe("p0");

    const room = server.getRoom(roomId)!;
    expect(room.hostPlayerId).toBe("p0");
    expect(room.seats.find((s) => s.playerId === "p0")!.connected).toBe(true);
    // Authority intact — they can still start the match themselves.
    expect(server.startMatch(roomId).ok).toBe(true);
  });

  it("promotes only once the window actually EXPIRES", async () => {
    // A short real window: the seat is released by the expiry timer,
    // which funnels through the same detachSeat path as a leave.
    const server = newServer({ reconnectReservationMs: 60 });
    const { roomId, sessions } = makeRoom(server, 3);
    expect(server.reserve(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0"); // still theirs

    await sleep(200); // past the window

    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    expect(server.startMatch(roomId).ok).toBe(true);
  });

  it("keeps the host for a dropped host when an UNRELATED player leaves", () => {
    // The scenario that makes "is the host still seated?" load-bearing:
    // the host is mid-window AND is not the lowest occupied seat, then
    // somebody else leaves and re-runs succession. A rule that treats a
    // reserved seat as vacant would quietly hand the room to the lowest
    // seat while its rightful host is still coming back.
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 3);

    // Rearrange so the host is NOT seat 0: p0 leaves (p1 succeeds), then
    // a newcomer fills the free seat 0.
    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    const newcomer = server.connect();
    expect(server.joinRoom(newcomer, roomId).ok).toBe(true);
    expect(server.getSeat(newcomer)!.playerId).toBe("p0");

    // The host (seat 1) drops into their reconnect window…
    expect(server.reserve(sessions[1]!).ok).toBe(true);
    // …and an unrelated player leaves, re-running succession.
    expect(server.leaveRoom(sessions[2]!).ok).toBe(true);

    // The room is NOT handed to p0: p1 is still coming back.
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");

    // And they really do resume as host.
    expect(server.reconnect(tokens[1]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    expect(server.startMatch(roomId).ok).toBe(true);
  });

  it("a reserved player is still a valid successor", async () => {
    // p1 is mid-window when the host leaves for good. Their seat is
    // occupied, so they are promoted — and they get the host back when
    // they reconnect, rather than the room skipping them.
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 3);
    expect(server.reserve(sessions[1]!).ok).toBe(true);

    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");

    const recovered = server.reconnect(tokens[1]!);
    expect(recovered.ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Every room state
// ────────────────────────────────────────────────────────────────────────

describe("succession works in every room state", () => {
  it("in a waiting lobby", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    expect(server.getRoom(roomId)!.state).toBe("waiting");
    server.leaveRoom(sessions[0]!);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
  });

  it("mid-match, where the host's seat is vacated rather than freed", () => {
    // Host identity does not gate anything DURING a match (only
    // start_match is host-only), but the room must still come out of the
    // match with a usable host — otherwise the rematch is stuck.
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    expect(server.startMatch(roomId).ok).toBe(true);

    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
  });

  it("in the post-match lobby, and the rematch then starts (Task 25)", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 3);
    const states = statePipe(server, sessions[1]!);
    expect(server.startMatch(roomId).ok).toBe(true);
    await playToFinish(server, roomId, sessions, states);

    // The host leaves while everyone is on the result screen.
    expect(server.leaveRoom(sessions[0]!).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");

    // The remaining players go back to the lobby and play again.
    expect(server.returnToLobby(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  }, 20000);

  it("in a public matchmade room", () => {
    // The creator of a public room is just the first person matched in;
    // succession applies identically (Task 17 policy untouched).
    const server = newServer();
    const sessions: Session[] = [];
    for (let i = 0; i < 3; i++) {
      const s = server.connect();
      expect(server.joinPublicRoom(s).ok).toBe(true);
      sessions.push(s);
    }
    const roomId = server.getSeat(sessions[0]!)!.room.id;
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p0");

    server.leaveRoom(sessions[0]!);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");
    expect(server.startMatch(roomId).ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task 18 teardown is untouched
// ────────────────────────────────────────────────────────────────────────

describe("an empty room is still destroyed, never succeeded", () => {
  it("the last player leaving destroys the room", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    server.leaveRoom(sessions[0]!);
    expect(server.getRoom(roomId)!.hostPlayerId).toBe("p1");

    server.leaveRoom(sessions[1]!); // nobody left to promote
    expect(server.getRoom(roomId)).toBeNull();
    expect(server.roomCount()).toBe(0);
  });

  it("a solo creator leaving destroys the room", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 1);
    server.leaveRoom(sessions[0]!);
    expect(server.getRoom(roomId)).toBeNull();
    expect(server.roomCount()).toBe(0);
  });

  it("an expiring last reservation destroys the room", async () => {
    const server = newServer({ reconnectReservationMs: 60 });
    const { roomId, sessions } = makeRoom(server, 1);
    expect(server.reserve(sessions[0]!).ok).toBe(true);
    await sleep(200);
    expect(server.getRoom(roomId)).toBeNull();
  });

  it("removeEmptyRooms still reports nothing for an occupied room", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    server.leaveRoom(sessions[0]!);
    expect(server.removeEmptyRooms()).toBe(0);
    expect(server.getRoom(roomId)).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Capacity-wide sanity
// ────────────────────────────────────────────────────────────────────────

describe("succession at full capacity", () => {
  it("walks the whole room down to the last player", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, MAX_PLAYERS);
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      expect(server.getRoom(roomId)!.hostPlayerId).toBe(`p${i}`);
      server.leaveRoom(sessions[i]!);
    }
    expect(server.getRoom(roomId)!.hostPlayerId).toBe(`p${MAX_PLAYERS - 1}`);
    server.leaveRoom(sessions[MAX_PLAYERS - 1]!);
    expect(server.getRoom(roomId)).toBeNull();
  });
});
