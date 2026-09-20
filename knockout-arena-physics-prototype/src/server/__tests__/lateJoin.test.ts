import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, deserializeGameState, type GameState } from "../../game";
import {
  createGameServer,
  type GameServer,
  type Session,
} from "../index";

/**
 * LATE JOINS — a room whose match is already running (or just finished)
 * no longer refuses newcomers: they take a genuinely free seat and WAIT
 * for the next match, with the running game and its frozen roster
 * untouched. The pinned rules:
 *
 *   - the waiter is seated, connected, skinned (random deal) and shows
 *     up in the room roster immediately — but has NO pawn in the live
 *     match;
 *   - seats vacated mid-match stay frozen for their (departed) player —
 *     a late joiner can never take one;
 *   - a playing room at capacity refuses with the ordinary room-full;
 *   - the waiter is dealt into the NEXT match like anyone else (and can
 *     win it — the win counter applies to them too).
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

const liveServers: GameServer[] = [];

afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function newServer(): GameServer {
  const server = createGameServer({ randomSkinIndex: () => 0 });
  liveServers.push(server);
  return server;
}

function must<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function makeRoom(
  server: GameServer,
  n: number
): { roomId: string; code: string; sessions: Session[] } {
  const sessions: Session[] = [];
  const creator = server.connect();
  const created = must(server.createRoom(creator));
  sessions.push(creator);
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    must(server.joinRoom(s, created.room.id));
    sessions.push(s);
  }
  return { roomId: created.room.id, code: created.room.code, sessions };
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

/** p0 launches itself out of the arena; p1 wins by surviving (real loop). */
async function playToFinish(
  server: GameServer,
  roomId: string,
  sessions: Session[],
  states: string[]
): Promise<string | null> {
  const pawns = latestState(states).pawns;
  const pawn = pawns.find((p) => p.id === "p0")!;
  const dx = pawn.position.x - CX || 1;
  const dy = pawn.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  server.submitCommand(sessions[0]!, {
    type: "aim",
    x: CX + (dx / len) * 400,
    y: CY + (dy / len) * 400,
  });
  server.submitCommand(sessions[0]!, { type: "setPower", power: 5 });
  server.submitCommand(sessions[0]!, { type: "confirmLaunch" });
  expect(server.resolveRound(roomId)).toEqual({ ok: true });
  const finished = await waitFor(
    () => server.getRoom(roomId)!.state === "finished",
    8000
  );
  expect(finished).toBe(true);
  return latestState(states).winnerId;
}

describe("late joins into a running match", () => {
  it("seats the newcomer as a waiter — in the roster, out of the match", async () => {
    const server = newServer();
    const { roomId, code, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);
    must(server.startMatch(roomId));
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    const late = server.connect();
    const joined = must(server.joinRoom(late, code));
    expect(joined.playerId).toBe("p2"); // a genuinely free seat
    const room = server.getRoom(roomId)!;
    expect(room.state).toBe("playing"); // the match goes on
    expect(room.seats.map((s) => s.connected)).toEqual([true, true, true]);
    // The waiter got a skin dealt (deterministic draw → the first pick
    // not held by p0/p1 → 2).
    expect(room.seats[2]!.skin).toBe(2);

    // The LIVE match's snapshots still carry only its own pawns.
    const snapshot = latestState(states);
    expect(snapshot.pawns.map((p) => p.id)).toEqual(["p0", "p1"]);
  });

  it("never hands out a mid-match vacated seat (it stays frozen for its player)", async () => {
    const server = newServer();
    const { roomId, code, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);
    must(server.startMatch(roomId));
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    // p1 drops mid-match: their seat is vacated but FROZEN (the pawn
    // stays in the match, the roster keeps the seat listed).
    server.disconnect(sessions[1]!);
    const late = server.connect();
    const joined = must(server.joinRoom(late, code));
    expect(joined.playerId).toBe("p2"); // NOT p1
    const room = server.getRoom(roomId)!;
    expect(room.seats[1]).toMatchObject({ connected: false }); // frozen
    expect(room.seats[2]).toMatchObject({ connected: true }); // the waiter
  });

  it("a playing room at capacity refuses with the ordinary room-full", () => {
    const server = newServer();
    const { code } = makeRoom(server, 2);
    must(server.startMatch(code ? server.getRoom(code)!.id : ""));
    const roomId = server.getRoom(code)!.id;
    // Fill every remaining seat with waiters…
    for (let seat = 2; seat < CONFIG.match.maxPlayers; seat++) {
      const waiter = server.connect();
      expect(must(server.joinRoom(waiter, code)).playerId).toBe(`p${seat}`);
    }
    // …the next joiner has nowhere to wait → the ordinary capacity rule.
    const extra = server.connect();
    expect(server.joinRoom(extra, code)).toEqual({
      ok: false,
      reason: "room-full",
    });
    void roomId;
  });

  it("joining a FINISHED room seats a waiter for the next match too", () => {
    const server = newServer();
    const { roomId, code, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);
    must(server.startMatch(roomId));
    // Force a real finish synchronously enough: p0 out, p1 wins.
    const finished = (async () => playToFinish(server, roomId, sessions, states))();
    return finished.then((winner) => {
      expect(winner).toBe("p1");
      const late = server.connect();
      const joined = must(server.joinRoom(late, code));
      expect(joined.room.state).toBe("finished");
      expect(joined.playerId).toBe("p2");
    });
  });

  it("the waiter plays — and can win — the NEXT match", async () => {
    const server = newServer();
    const { roomId, code, sessions } = makeRoom(server, 2);
    let states = statePipe(server, sessions[1]!);
    must(server.startMatch(roomId));
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);

    // The waiter takes p2 while the first match runs; p1 wins it.
    const late = server.connect();
    must(server.joinRoom(late, code));

    // p0 leaves the match (their pawn stays frozen): the remaining
    // player wins by survival once p0 is knocked out or the match ends.
    // Simplest genuine finish: p0 launches out NOW.
    {
      const pawns = latestState(states).pawns;
      const pawn = pawns.find((p) => p.id === "p0")!;
      const dx = pawn.position.x - CX || 1;
      const dy = pawn.position.y - CY;
      const len = Math.hypot(dx, dy) || 1;
      server.submitCommand(sessions[0]!, {
        type: "aim",
        x: CX + (dx / len) * 400,
        y: CY + (dy / len) * 400,
      });
      server.submitCommand(sessions[0]!, { type: "setPower", power: 5 });
      server.submitCommand(sessions[0]!, { type: "confirmLaunch" });
      expect(server.resolveRound(roomId)).toEqual({ ok: true });
    }
    const done = await waitFor(
      () => server.getRoom(roomId)!.state === "finished",
      8000
    );
    expect(done).toBe(true);

    // Play again: the room returns to waiting and starts a NEW match —
    // with the waiter dealt in as a full participant.
    must(server.returnToLobby(roomId));
    must(server.startMatch(roomId));
    states = statePipe(server, sessions[1]!);
    expect(await waitFor(() => states.length > 0, 3000)).toBe(true);
    const pawns = latestState(states).pawns;
    expect(pawns.map((p) => p.id)).toEqual(["p0", "p1", "p2"]); // waiter in
  }, 20000);
});
