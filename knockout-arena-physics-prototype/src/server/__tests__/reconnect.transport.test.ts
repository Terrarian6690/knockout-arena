import { afterEach, describe, expect, it } from "vitest";
import type { GameStateSnapshot } from "../../game";
import {
  createGameServer,
  createTransportCore,
  type ConnectionHandle,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";

/**
 * Seat recovery over the WIRE (fake sockets driving the same
 * createTransportCore the real ws server runs): the reconnect message,
 * the credential in the welcome, connection takeover, reservation
 * visibility and rejections. The facade semantics (identity, expiry
 * rules) live in reconnect.test.ts; real-socket coverage of drops and
 * notifications lives in transport.e2e.test.ts.
 */

// ── fake socket (same shape as transport.test.ts) ────────────────────────

class FakeSocket implements TransportSocket {
  sent: string[] = [];
  bufferedAmount = 0;
  closed = false;
  private messageHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageHandlers.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }
  onError(_cb: (error: unknown) => void): void {
    // fake sockets never error; cleanup is exercised via close()
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeHandlers) cb();
  }

  receive(raw: string): void {
    for (const cb of [...this.messageHandlers]) cb(raw);
  }
  receiveMsg(message: unknown): void {
    this.receive(JSON.stringify(message));
  }
  json(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.json().filter(
      (m): m is Record<string, unknown> =>
        typeof m === "object" && m !== null && (m as { type?: unknown }).type === type
    );
  }
  lastOf(type: string): Record<string, unknown> | undefined {
    const all = this.ofType(type);
    return all[all.length - 1];
  }
}

// ── harness ───────────────────────────────────────────────────────────────

const liveServers: GameServer[] = [];
function newCore(options?: { reconnectReservationMs?: number }): {
  server: GameServer;
  core: TransportCore;
} {
  const server = createGameServer({
    reconnectReservationMs: options?.reconnectReservationMs,
  });
  liveServers.push(server);
  return { server, core: createTransportCore(server) };
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function connect(core: TransportCore): { socket: FakeSocket; handle: ConnectionHandle } {
  const socket = new FakeSocket();
  const handle = core.attach(socket);
  return { socket, handle };
}

const msg = {
  create: { protocolVersion: 1, type: "create_room" },
  start: { protocolVersion: 1, type: "start_match" },
};

function join(roomId: string) {
  return { protocolVersion: 1, type: "join_room", roomId };
}

function reconnectMsg(token: string) {
  return { protocolVersion: 1, type: "reconnect", token };
}

/** The parsed welcome of a socket that just created/joined/reconnected. */
function welcomeOf(socket: FakeSocket): Record<string, unknown> {
  const welcome = socket.lastOf("welcome");
  if (welcome === undefined) throw new Error("no welcome sent");
  return welcome;
}

/** Connect + create; returns creator socket + its credential + room id. */
function createdRoom(core: TransportCore): {
  socket: FakeSocket;
  handle: ConnectionHandle;
  roomId: string;
  token: string;
} {
  const { socket, handle } = connect(core);
  socket.receiveMsg(msg.create);
  const welcome = welcomeOf(socket);
  return {
    socket,
    handle,
    roomId: welcome.roomId as string,
    token: welcome.reconnectToken as string,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ────────────────────────────────────────────────────────────────────────

describe("reconnect over the wire", () => {
  it("create_room and join_room welcomes carry the seat's credential", () => {
    const { core } = newCore();
    const creator = createdRoom(core);
    expect(typeof creator.token).toBe("string");
    expect(creator.token.length).toBeGreaterThan(20); // opaque, not guessable
    expect(creator.token).not.toBe(creator.roomId);
    expect(creator.token).not.toBe("p0");

    const joiner = connect(core).socket;
    joiner.receiveMsg(join(creator.roomId));
    const joined = welcomeOf(joiner);
    expect(joined.playerId).toBe("p1");
    expect(typeof joined.reconnectToken).toBe("string");
    expect(joined.reconnectToken).not.toBe(creator.token);

    // The credential never appears anywhere else on the wire: not in the
    // broadcasts, not in rosters, not in snapshots — and a welcome carries
    // only its own recipient's credential.
    const joinerToken = welcomeOf(joiner).reconnectToken as string;
    const owners: Array<[FakeSocket, string]> = [
      [creator.socket, creator.token],
      [joiner, joinerToken],
    ];
    for (const [socket, own] of owners) {
      const other = own === creator.token ? joinerToken : creator.token;
      for (const message of socket.json() as Array<Record<string, unknown>>) {
        const raw = JSON.stringify(message);
        if (message.type === "welcome") {
          expect(raw).toContain(own); // own welcome, own credential…
          expect(raw).not.toContain(other); // …and never anyone else's
        } else {
          expect(raw).not.toContain(own); // broadcasts carry no credentials
          expect(raw).not.toContain(other);
        }
      }
    }
  });

  it("a dropped seat recovers on a new connection: welcome, room state, same identity", () => {
    const { server, core } = newCore();
    const creator = createdRoom(core);
    const joiner = connect(core).socket;
    joiner.receiveMsg(join(creator.roomId));
    const joinerToken = welcomeOf(joiner).reconnectToken as string;

    // The joiner's connection drops (socket loss → reservation).
    joiner.close();
    // …the room shows the seat reserved (disconnected, not freed)…
    const reserved = creator.socket.lastOf("room_state")!;
    expect(reserved.roster).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: false },
    ]);
    expect(server.sessionCount()).toBe(2);

    // …and a fresh connection reclaims it with the credential.
    const revived = connect(core).socket;
    revived.receiveMsg(reconnectMsg(joinerToken));
    const welcome = welcomeOf(revived);
    expect(welcome).toMatchObject({
      playerId: "p1",
      roomId: creator.roomId,
      roomState: "waiting",
      hostPlayerId: "p0",
    });
    expect(typeof welcome.reconnectToken).toBe("string");
    // Everyone (including the old member) sees p1 connected again.
    expect(creator.socket.lastOf("room_state")!.roster).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: true },
    ]);
    expect(server.getRoom(creator.roomId)!.seats).toHaveLength(2); // no duplicates
    expect(server.sessionCount()).toBe(2); // fresh session discarded
  });

  it("mid-match reconnect pushes the current match state immediately", async () => {
    const { core } = newCore();
    const creator = createdRoom(core);
    const joiner = connect(core).socket;
    joiner.receiveMsg(join(creator.roomId));
    const joinerToken = welcomeOf(joiner).reconnectToken as string;

    creator.socket.receiveMsg(msg.start);
    expect(
      await waitFor(() => joiner.ofType("snapshot").length > 0, 3000)
    ).toBe(true);

    joiner.close(); // drop mid-match
    const revived = connect(core).socket;
    revived.receiveMsg(reconnectMsg(joinerToken));
    // The welcome comes with the room picture…
    expect(welcomeOf(revived).roomState).toBe("playing");
    // …and the subscription immediately delivers the live match state,
    // projected for the RECOVERED seat (p1's own pawn).
    const snapshot = revived.lastOf("snapshot");
    expect(snapshot).toBeDefined();
    expect((snapshot!.state as GameStateSnapshot).localPawnId).toBe("p1");
    expect((snapshot!.state as GameStateSnapshot).phase).toBe("aiming");
  }, 8000);

  it("a valid credential takes over: the old live connection is closed and dead", () => {
    const { server, core } = newCore();
    const creator = createdRoom(core);

    // The creator's ORIGINAL connection is still fully live when a second
    // connection presents the creator's credential.
    const impostor = connect(core).socket;
    impostor.receiveMsg(reconnectMsg(creator.token));
    expect(welcomeOf(impostor).playerId).toBe("p0"); // same seat reclaimed

    // The old connection was invalidated: its socket is closed…
    expect(creator.socket.closed).toBe(true);
    // …and its (already-fired) cleanup neither reserved nor disconnected
    // the session — the identity lives on in the new connection.
    expect(server.sessionCount()).toBe(1);
    expect(server.getRoom(creator.roomId)!.seats).toEqual([
      { playerId: "p0", connected: true },
    ]);
    // Messages on the dead socket go nowhere.
    const sentBefore = creator.socket.sent.length;
    creator.socket.receiveMsg(msg.create);
    expect(creator.socket.sent.length).toBe(sentBefore);
    expect(server.roomCount()).toBe(1); // no second room from the dead socket
  });

  it("an invalid credential is a clean protocol error; the connection stays usable", () => {
    const { core } = newCore();
    const socket = connect(core).socket;
    socket.receiveMsg(reconnectMsg("totally-made-up-credential"));
    expect(socket.lastOf("error")).toMatchObject({ code: "invalid-reconnect" });

    // The connection itself is fine: it can still create a room.
    socket.receiveMsg(msg.create);
    expect(welcomeOf(socket).playerId).toBe("p0");
  });

  it("an expired credential is the same clean error, and the seat is released", async () => {
    const { server, core } = newCore({ reconnectReservationMs: 40 });
    const creator = createdRoom(core);
    creator.socket.close();
    expect(await waitFor(() => server.sessionCount() === 0, 3000)).toBe(true);

    const late = connect(core).socket;
    late.receiveMsg(reconnectMsg(creator.token));
    expect(late.lastOf("error")).toMatchObject({ code: "invalid-reconnect" });
    // The freed seat is claimable by a fresh joiner per the normal rules.
    const newcomer = connect(core).socket;
    newcomer.receiveMsg(msg.create); // fresh room works again
    expect(welcomeOf(newcomer).playerId).toBe("p0");
    expect(server.roomCount()).toBe(1);
  });

  it("reconnect while already seated on this connection is rejected", () => {
    const { server, core } = newCore();
    const creator = createdRoom(core);
    // This connection already holds p0 — it may not also "recover" a seat.
    creator.socket.receiveMsg(reconnectMsg(creator.token));
    expect(creator.socket.lastOf("error")).toMatchObject({
      code: "already-in-room",
    });
    // The seat is untouched by the rejected attempt.
    expect(server.getRoom(creator.roomId)!.seats).toEqual([
      { playerId: "p0", connected: true },
    ]);
  });

  it("malformed reconnect envelopes are rejected by the strict parser", () => {
    const { core } = newCore();
    const socket = connect(core).socket;
    for (const raw of [
      JSON.stringify({ protocolVersion: 1, type: "reconnect" }), // no token
      JSON.stringify({ protocolVersion: 1, type: "reconnect", token: "" }), // empty
      JSON.stringify({ protocolVersion: 1, type: "reconnect", token: 42 }), // not a string
      JSON.stringify({
        protocolVersion: 1,
        type: "reconnect",
        token: "x",
        extra: true,
      }), // strict envelope
    ]) {
      socket.receive(raw);
      expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    }
    // Nothing above created a seat or a room.
    expect(socket.lastOf("welcome")).toBeUndefined();
  });

  it("a reserved seat is not visible to joiners", () => {
    const { core } = newCore();
    const creator = createdRoom(core);
    const joiner = connect(core).socket;
    joiner.receiveMsg(join(creator.roomId));
    const joinerToken = welcomeOf(joiner).reconnectToken as string;

    joiner.close(); // reserved
    // A fresh connection joining the room gets p2 — not p1's reserved seat.
    const third = connect(core).socket;
    third.receiveMsg(join(creator.roomId));
    expect(welcomeOf(third).playerId).toBe("p2");
    // And the reserved player still recovers p1 with its credential.
    const revived = connect(core).socket;
    revived.receiveMsg(reconnectMsg(joinerToken));
    expect(welcomeOf(revived).playerId).toBe("p1");
  });
});

