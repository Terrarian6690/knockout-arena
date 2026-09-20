import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import {
  createGameServer,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type GameServer,
  type Session,
} from "../index";

/**
 * SIX-PLAYER capacity — server half (Task 7).
 *
 * Capacity is server policy: seats, the rejection past the last one,
 * host/reconnect semantics and the authoritative six-player snapshot.
 * Everything here goes through the real game server, so these are the
 * rules a client actually meets.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

const liveServers: GameServer[] = [];
afterEach(() => {
  for (const s of liveServers) s.destroy();
  liveServers.length = 0;
});

function newServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}

interface Room {
  roomId: string;
  code: string;
  sessions: Session[];
  playerIds: string[];
  tokens: string[];
}

/** Seat `n` players in one room, the first being the creator/host. */
function makeRoom(server: GameServer, n: number): Room {
  const creator = server.connect();
  const created = server.createRoom(creator);
  if (!created.ok) throw new Error("createRoom failed");
  const room: Room = {
    roomId: created.room.id,
    code: created.room.code,
    sessions: [creator],
    playerIds: [created.playerId],
    tokens: [created.reconnectToken],
  };
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, room.roomId);
    if (!joined.ok) throw new Error(`joinRoom ${i} failed: ${joined.reason}`);
    room.sessions.push(s);
    room.playerIds.push(joined.playerId);
    room.tokens.push(joined.reconnectToken);
  }
  return room;
}

function viewSink(server: GameServer, session: Session): GameStateSnapshot[] {
  const views: GameStateSnapshot[] = [];
  server.onRoomView(session, (v) => views.push(v));
  return views;
}

const last = (views: GameStateSnapshot[]): GameStateSnapshot => {
  const v = views[views.length - 1];
  if (v === undefined) throw new Error("no view pushed");
  return v;
};

describe("room capacity is six", () => {
  it("accepts players one through six", () => {
    const server = newServer();
    const creator = server.connect();
    const created = server.createRoom(creator);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.playerId).toBe("p0");

    // Players 2..6 each join successfully, in order.
    for (let i = 1; i < MAX_PLAYERS; i++) {
      const s = server.connect();
      const joined = server.joinRoom(s, created.room.id);
      expect(joined.ok).toBe(true);
      if (!joined.ok) throw new Error("unreachable");
      expect(joined.playerId).toBe(`p${i}`);
      expect(joined.room.seats).toHaveLength(i + 1);
    }
    expect(server.getRoom(created.room.id)!.seats).toHaveLength(6);
  });

  it("assigns six UNIQUE seats, p0..p5, in join order", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    expect(room.playerIds).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(new Set(room.playerIds).size).toBe(6);
    // …and the server reports exactly those seats, all connected.
    const info = server.getRoom(room.roomId)!;
    expect(info.seats.map((s) => s.playerId)).toEqual(room.playerIds);
    expect(info.seats.every((s) => s.connected)).toBe(true);
  });

  it("rejects the SEVENTH player cleanly (room-full, nothing else changes)", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const before = server.getRoom(room.roomId)!;

    const seventh = server.connect();
    expect(server.joinRoom(seventh, room.roomId)).toEqual({
      ok: false,
      reason: "room-full",
    });
    // The refused connection holds no seat…
    expect(server.getSeat(seventh)).toBeNull();
    // …and the room is untouched: same six seats, same host.
    const after = server.getRoom(room.roomId)!;
    expect(after.seats).toEqual(before.seats);
    expect(after.hostPlayerId).toBe(before.hostPlayerId);
    // The refused session is still usable elsewhere (a clean rejection,
    // not a broken connection): it can create its own room.
    expect(server.createRoom(seventh).ok).toBe(true);
  });

  it("rejects by ROOM CODE past capacity too", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const extra = server.connect();
    expect(server.joinRoom(extra, room.code)).toEqual({
      ok: false,
      reason: "room-full",
    });
  });

  it("keeps the host correct as all six seats fill", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    // The creator stays host no matter how many players arrive.
    expect(server.getRoom(room.roomId)!.hostPlayerId).toBe("p0");
    for (const session of room.sessions) {
      const seat = server.getSeat(session)!;
      expect(seat.room.hostPlayerId).toBe("p0");
    }
  });

  it("frees the sixth seat when that player leaves, and refills it", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    expect(server.leaveRoom(room.sessions[5]).ok).toBe(true);
    expect(server.getRoom(room.roomId)!.seats).toHaveLength(5);

    // The freed seat is handed to the next joiner — same id, no gap.
    const replacement = server.connect();
    const joined = server.joinRoom(replacement, room.roomId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error("unreachable");
    expect(joined.playerId).toBe("p5");
  });

  it("still starts at the MINIMUM player count, not at six", () => {
    const server = newServer();
    const room = makeRoom(server, MIN_PLAYERS);
    expect(MIN_PLAYERS).toBe(2);
    expect(server.startMatch(room.roomId).ok).toBe(true);
  });
});

describe("a six-player match through the server", () => {
  it("starts with all six pawns in the authoritative snapshot", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const views = room.sessions.map((s) => viewSink(server, s));
    expect(server.startMatch(room.roomId).ok).toBe(true);

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const view = last(views[i]);
      expect(view.pawns).toHaveLength(6);
      expect(view.pawns.map((p) => p.id)).toEqual([
        "p0",
        "p1",
        "p2",
        "p3",
        "p4",
        "p5",
      ]);
      // Each viewer's own seat is identified from AUTHORITATIVE state.
      expect(view.localPawnId).toBe(`p${i}`);
    }
  });

  it("gives every one of the six a private aim, visible to nobody else", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const views = room.sessions.map((s) => viewSink(server, s));
    expect(server.startMatch(room.roomId).ok).toBe(true);

    // All six aim and set distinct powers.
    for (let i = 0; i < MAX_PLAYERS; i++) {
      expect(
        server.submitCommand(room.sessions[i], { type: "aim", x: CX, y: CY }).ok
      ).toBe(true);
      expect(
        server.submitCommand(room.sessions[i], {
          type: "setPower",
          // Stay inside the configured range for all six seats.
          power: CONFIG.power.min + (i % (CONFIG.power.max - CONFIG.power.min + 1)),
        }).ok
      ).toBe(true);
    }

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const view = last(views[i]);
      // Own aim and own power…
      expect(view.isAiming).toBe(true);
      expect(view.aimDirection).not.toBeNull();
      expect(view.power).toBe(
        CONFIG.power.min + (i % (CONFIG.power.max - CONFIG.power.min + 1))
      );
      // …and NOTHING of the other five: no launch datum during aiming.
      for (const pawn of view.pawns) expect(pawn.launch).toBeNull();
      // Not even in the raw wire payload.
      expect(JSON.stringify(view.pawns)).not.toContain("aimDirection");
    }
  });

  it("resolves six simultaneous launches in one transition", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const views = room.sessions.map((s) => viewSink(server, s));
    expect(server.startMatch(room.roomId).ok).toBe(true);

    for (let i = 0; i < MAX_PLAYERS; i++) {
      server.submitCommand(room.sessions[i], { type: "aim", x: CX, y: CY });
      server.submitCommand(room.sessions[i], { type: "setPower", power: 2 });
      server.submitCommand(room.sessions[i], { type: "confirmLaunch" });
      // The round only resolves once the LAST of the six confirms.
      const phase = last(views[0]).phase;
      expect(phase).toBe(i === MAX_PLAYERS - 1 ? "moving" : "aiming");
    }

    // Every viewer sees all six launches revealed, all six moving.
    for (const sink of views) {
      const view = last(sink);
      expect(view.phase).toBe("moving");
      expect(view.pawns).toHaveLength(6);
      for (const pawn of view.pawns) {
        expect(pawn.launch).not.toBeNull();
        expect(pawn.launch!.power).toBe(2);
      }
    }
  });

  it("keeps two six-player rooms completely isolated", () => {
    const server = newServer();
    const a = makeRoom(server, MAX_PLAYERS);
    const b = makeRoom(server, MAX_PLAYERS);
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.code).not.toBe(b.code);

    const viewsA = viewSink(server, a.sessions[0]);
    const viewsB = viewSink(server, b.sessions[0]);
    expect(server.startMatch(a.roomId).ok).toBe(true);

    // Room A is playing; room B has not started at all.
    expect(last(viewsA).pawns).toHaveLength(6);
    expect(viewsB).toHaveLength(0);
    expect(server.getRoom(b.roomId)!.state).toBe("waiting");

    // A command in room A never touches room B.
    server.submitCommand(a.sessions[0], { type: "aim", x: CX, y: CY });
    expect(viewsB).toHaveLength(0);

    // Both rooms still hold their own six distinct sessions.
    expect(server.getSeat(a.sessions[5])!.room.id).toBe(a.roomId);
    expect(server.getSeat(b.sessions[5])!.room.id).toBe(b.roomId);
  });

  it("eliminates six players independently and picks a winner", async () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const views = viewSink(server, room.sessions[0]);
    expect(server.startMatch(room.roomId).ok).toBe(true);

    /** Wait for the room's real 60 Hz loop to leave the moving phase. */
    const settle = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (last(views).phase === "moving" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    // Five players jump out one at a time; the sixth never moves.
    for (let i = 0; i < 5; i++) {
      expect(last(views).phase).toBe("aiming");
      const me = last(views).pawns.find((p) => p.id === `p${i}`)!;
      const dx = me.position.x - CX || 1;
      const dy = me.position.y - CY;
      const len = Math.hypot(dx, dy) || 1;
      server.submitCommand(room.sessions[i], {
        type: "aim",
        x: CX + (dx / len) * 900,
        y: CY + (dy / len) * 900,
      });
      server.submitCommand(room.sessions[i], { type: "setPower", power: 5 });
      server.submitCommand(room.sessions[i], { type: "confirmLaunch" });
      server.resolveRound(room.roomId); // the decision deadline
      await settle();

      // Exactly the players who jumped are out — eliminations are
      // independent, and nobody else was taken with them.
      const view = last(views);
      for (const pawn of view.pawns) {
        expect(pawn.eliminated).toBe(Number(pawn.id.slice(1)) <= i);
      }
      if (view.phase === "finished") break;
    }

    const final = last(views);
    expect(final.phase).toBe("finished");
    expect(final.pawns.filter((p) => !p.eliminated)).toHaveLength(1);
    expect(final.winnerId).toBe("p5");
  }, 30_000);
});

describe("seat integrity with six players", () => {
  it("never lets a client choose or forge its own seat", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    expect(server.startMatch(room.roomId).ok).toBe(true);
    const views = room.sessions.map((s) => viewSink(server, s));

    // p5 tries to act as p0 by smuggling a playerId into the command.
    const forged = { type: "aim", x: CX, y: CY, playerId: "p0" } as never;
    server.submitCommand(room.sessions[5], forged);

    // Whatever the server made of it, it was applied to the SENDER's own
    // seat (p5) — p0's view shows no aim of its own.
    expect(last(views[0]).isAiming).toBe(false);
    expect(last(views[0]).aimDirection).toBeNull();
    // And the seat mapping is unchanged.
    expect(server.getSeat(room.sessions[5])!.playerId).toBe("p5");
  });

  it("rejects privileged match-level commands from any of the six", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    expect(server.startMatch(room.roomId).ok).toBe(true);
    for (const session of room.sessions) {
      expect(server.submitCommand(session, { type: "resolveRound" })).toEqual({
        ok: false,
        reason: "unauthorized",
      });
      expect(server.submitCommand(session, { type: "reset" })).toEqual({
        ok: false,
        reason: "unauthorized",
      });
      expect(server.submitCommand(session, { type: "timeUp" })).toEqual({
        ok: false,
        reason: "unauthorized",
      });
    }
  });

  it("recovers the SIXTH seat after a disconnect (reservation intact)", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    expect(server.startMatch(room.roomId).ok).toBe(true);

    // p5 drops: the seat stays occupied but reports disconnected.
    expect(server.reserve(room.sessions[5])).toEqual({ ok: true });
    const during = server.getRoom(room.roomId)!;
    expect(during.seats).toHaveLength(6);
    expect(during.seats.find((s) => s.playerId === "p5")!.connected).toBe(false);
    // …and nobody can steal it while the window is open (the match is
    // running, so the join is refused outright).
    const thief = server.connect();
    const stolen = server.joinRoom(thief, room.roomId);
    expect(stolen.ok).toBe(false);
    expect(server.getRoom(room.roomId)!.seats).toHaveLength(6);

    // p5 comes back with its credential: same seat, same match.
    const back = server.reconnect(room.tokens[5]);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error("unreachable");
    expect(back.playerId).toBe("p5");
    expect(back.room.id).toBe(room.roomId);
    const after = server.getRoom(room.roomId)!;
    expect(after.seats.find((s) => s.playerId === "p5")!.connected).toBe(true);

    // The recovered client immediately receives the six-player view.
    const view = last(viewSink(server, back.session));
    expect(view.pawns).toHaveLength(6);
    expect(view.localPawnId).toBe("p5");
  });

  it("rejects an invalid credential without disturbing the six seats", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    expect(server.reconnect("not-a-real-token")).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
    expect(server.getRoom(room.roomId)!.seats).toHaveLength(6);
  });
});

describe("the six-player roster projection", () => {
  it("reports six seats with names, host and connection state", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    // Three players choose names; the rest keep the seat fallback.
    server.setName(room.sessions[0], "Ada");
    server.setName(room.sessions[3], "Grace");
    server.setName(room.sessions[5], "Lin");

    const info = server.getRoom(room.roomId)!;
    expect(info.seats).toHaveLength(6);
    expect(info.seats.map((s) => s.playerId)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
    expect(info.seats.map((s) => s.displayName)).toEqual([
      "Ada",
      null,
      null,
      "Grace",
      null,
      "Lin",
    ]);
    expect(info.seats.every((s) => s.connected)).toBe(true);
    expect(info.hostPlayerId).toBe("p0");
  });

  it("carries the chosen names of all six into the match roster", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      server.setName(room.sessions[i], `Name${i}`);
    }
    const views = viewSink(server, room.sessions[0]);
    expect(server.startMatch(room.roomId).ok).toBe(true);
    expect(last(views).pawns.map((p) => p.name)).toEqual([
      "Name0",
      "Name1",
      "Name2",
      "Name3",
      "Name4",
      "Name5",
    ]);
  });

  it("falls back to Player N for unnamed seats among six", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const views = viewSink(server, room.sessions[0]);
    expect(server.startMatch(room.roomId).ok).toBe(true);
    expect(last(views).pawns.map((p) => p.name)).toEqual([
      "Player 1",
      "Player 2",
      "Player 3",
      "Player 4",
      "Player 5",
      "Player 6",
    ]);
  });
});

describe("a fresh match restores six-player capacity", () => {
  it("resets a finished six-player match back to six live seats", () => {
    const server = newServer();
    const room = makeRoom(server, MAX_PLAYERS);
    const views = viewSink(server, room.sessions[0]);
    expect(server.startMatch(room.roomId).ok).toBe(true);
    expect(last(views).pawns).toHaveLength(6);

    expect(server.resetMatch(room.roomId).ok).toBe(true);
    const after = last(views);
    expect(after.pawns).toHaveLength(6);
    expect(after.pawns.every((p) => !p.eliminated)).toBe(true);
    expect(after.winnerId).toBeNull();
    expect(after.phase).toBe("aiming");

    // Still exactly six seats — no capacity was lost along the way.
    expect(server.getRoom(room.roomId)!.seats).toHaveLength(6);
    expect(after.pawns.map((p) => p.id)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
  });
});
