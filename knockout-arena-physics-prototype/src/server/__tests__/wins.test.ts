import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, deserializeGameState, type GameState } from "../../game";
import {
  createGameServer,
  type GameServer,
  type Session,
} from "../index";
import { roomStateMessage } from "../protocol";

/**
 * SEAT WINS — the win counter the lobby list sorts and crowns by.
 *
 * A finished match credits its winner's seat with one win (a wipeout —
 * a finished match with no winner — credits nobody). The count lives on
 * the SEAT'S OCCUPANT: it accumulates across play-again rematches (the
 * roster — and the group — survive them), and a seat that changes owner
 * (a freed lobby seat, a mid-match departure whose seat reopens) starts
 * from zero again, exactly like the display name and the skin.
 *
 * The wire carries `wins` only when it is NON-ZERO (additive protocol
 * v1), so a fresh room's payloads stay byte-identical to before.
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
): { roomId: string; sessions: Session[] } {
  const sessions: Session[] = [];
  const creator = server.connect();
  const created = must(server.createRoom(creator));
  sessions.push(creator);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    must(server.joinRoom(s, roomId));
    sessions.push(s);
  }
  return { roomId, sessions };
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
 * Play a REAL match to a real winner (the same technique the rematch
 * suite uses): p0 launches itself out of the arena, p1 never chooses —
 * the server settles the round, p1 is the last one standing, and the
 * match finishes. Returns the winner id (always "p1").
 */
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

describe("seat wins", () => {
  it("credits the winner's seat once per match, accumulating over rematches", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);

    must(server.startMatch(roomId));
    const winner = await playToFinish(server, roomId, sessions, states);
    expect(winner).toBe("p1");
    expect(server.getRoom(roomId)!.seats.map((s) => s.wins ?? 0)).toEqual([0, 1]);

    // The rematch keeps the seats — and the win count.
    must(server.returnToLobby(roomId));
    must(server.startMatch(roomId));
    const winner2 = await playToFinish(server, roomId, sessions, states);
    expect(winner2).toBe("p1");
    expect(server.getRoom(roomId)!.seats.map((s) => s.wins ?? 0)).toEqual([0, 2]);
  }, 20000);

  it("a wipeout (no winner) credits nobody", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);
    must(server.startMatch(roomId));

    // BOTH players launch out of the arena in the same round: nobody is
    // left standing, so the match finishes with NO winner at all.
    for (const session of sessions) {
      const pawns = latestState(states).pawns;
      const pawn = pawns.find((p) => p.id === (session === sessions[0] ? "p0" : "p1"))!;
      const dx = pawn.position.x - CX || 1;
      const dy = pawn.position.y - CY;
      const len = Math.hypot(dx, dy) || 1;
      server.submitCommand(session, {
        type: "aim",
        x: CX + (dx / len) * 400,
        y: CY + (dy / len) * 400,
      });
      server.submitCommand(session, { type: "setPower", power: 5 });
      server.submitCommand(session, { type: "confirmLaunch" });
    }
    // Everyone confirmed → the round resolves itself; both pawns launch.

    const done = await waitFor(
      () => server.getRoom(roomId)!.state === "finished",
      8000
    );
    expect(done).toBe(true);
    expect(latestState(states).winnerId).toBeNull();
    // The match ended with NO winner: nobody is credited.
    expect(server.getRoom(roomId)!.seats.map((s) => s.wins ?? 0)).toEqual([0, 0]);
  }, 20000);

  it("wins belong to the OCCUPANT: a freed seat starts its next player at zero", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);
    must(server.startMatch(roomId));
    await playToFinish(server, roomId, sessions, states);
    must(server.returnToLobby(roomId));
    expect(server.getRoom(roomId)!.seats.map((s) => s.wins ?? 0)).toEqual([0, 1]);

    // The winner leaves; the seat is freed with the normal lobby rules.
    must(server.leaveRoom(sessions[1]!));
    const next = server.connect();
    must(server.joinRoom(next, roomId)); // takes the freed seat p1
    expect(server.getRoom(roomId)!.seats.map((s) => s.wins ?? 0)).toEqual([0, 0]);
  }, 20000);
});

describe("wins on the wire", () => {
  it("zero wins stay omitted; non-zero wins ride the roster", async () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    const states = statePipe(server, sessions[1]!);

    // A fresh room: every seat's payload has NO wins key at all.
    const view0 = server.getSeat(sessions[0]!);
    if (!view0) throw new Error("host seat gone");
    const fresh = JSON.parse(roomStateMessage(view0.room)) as {
      roster: Array<Record<string, unknown>>;
    };
    expect("wins" in fresh.roster[0]!).toBe(false);
    expect("wins" in fresh.roster[1]!).toBe(false);

    must(server.startMatch(roomId));
    await playToFinish(server, roomId, sessions, states);
    must(server.returnToLobby(roomId));

    const view1 = server.getSeat(sessions[0]!);
    if (!view1) throw new Error("host seat gone");
    const after = JSON.parse(roomStateMessage(view1.room)) as {
      roster: Array<Record<string, unknown>>;
    };
    expect(after.roster[0]).toMatchObject({ playerId: "p0" });
    expect("wins" in after.roster[0]!).toBe(false); // p0 never won
    expect(after.roster[1]).toMatchObject({ playerId: "p1", wins: 1 });
  }, 20000);
});
