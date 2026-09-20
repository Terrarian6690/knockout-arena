import { afterEach, describe, expect, it } from "vitest";
import {
  createGameServer,
  createTransportCore,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";
import { MAX_PLAYERS } from "../roomManager";

/**
 * PUBLIC MATCHMAKING OVER THE WIRE (Task 17).
 *
 * The manager-level rules are covered in matchmaking.test.ts; this pins
 * the protocol surface: the join_public frame, the welcome it produces,
 * and that a matchmade seat is indistinguishable from any other seat
 * downstream (room_state broadcast, start_match, leave).
 */

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
  onError(_cb: (error: unknown) => void): void {}
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

const liveServers: GameServer[] = [];
function newCore(): { server: GameServer; core: TransportCore } {
  const server = createGameServer({ randomSkinIndex: () => 0 });
  liveServers.push(server);
  return { server, core: createTransportCore(server) };
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function connect(core: TransportCore): FakeSocket {
  const socket = new FakeSocket();
  core.attach(socket);
  return socket;
}

const PUBLIC = { protocolVersion: 1, type: "join_public" };
const START = { protocolVersion: 1, type: "start_match" };
const joinByCode = (roomId: string) => ({
  protocolVersion: 1,
  type: "join_room",
  roomId,
});

function welcomeOf(socket: FakeSocket): Record<string, unknown> {
  const welcome = socket.lastOf("welcome");
  if (welcome === undefined) throw new Error("no welcome sent");
  return welcome;
}

/** Seat `n` fresh connections via matchmaking. */
function quickJoin(core: TransportCore, n: number): FakeSocket[] {
  return Array.from({ length: n }, () => {
    const socket = connect(core);
    socket.receiveMsg(PUBLIC);
    return socket;
  });
}

describe("the join_public frame", () => {
  it("seats the player and returns a normal welcome", () => {
    const { core } = newCore();
    const socket = connect(core);
    socket.receiveMsg(PUBLIC);

    const welcome = welcomeOf(socket);
    expect(welcome.playerId).toBe("p0");
    expect(typeof welcome.roomId).toBe("string");
    expect(typeof welcome.reconnectToken).toBe("string");
    expect(socket.ofType("error")).toEqual([]);
  });

  it("produces the same welcome SHAPE as create_room", () => {
    const { core } = newCore();
    const pub = connect(core);
    pub.receiveMsg(PUBLIC);
    const priv = connect(core);
    priv.receiveMsg({ protocolVersion: 1, type: "create_room" });

    // Matchmaking must not introduce a bespoke response.
    expect(Object.keys(welcomeOf(pub)).sort()).toEqual(
      Object.keys(welcomeOf(priv)).sort()
    );
  });

  it("rejects extra fields (no smuggled room targeting)", () => {
    const { core } = newCore();
    const socket = connect(core);
    // A client must not be able to steer matchmaking at a chosen room.
    socket.receiveMsg({ ...PUBLIC, roomId: "ABCD" });

    expect(socket.ofType("welcome")).toEqual([]);
    expect(socket.lastOf("error")?.code).toBe("malformed-payload");
  });

  it("seats a second player into the same room", () => {
    const { core } = newCore();
    const [a, b] = quickJoin(core, 2);

    expect(welcomeOf(b!).roomId).toBe(welcomeOf(a!).roomId);
    expect(welcomeOf(b!).playerId).toBe("p1");
  });

  it("tells the existing players someone joined", () => {
    const { core } = newCore();
    const [a] = quickJoin(core, 1);
    const before = a!.ofType("room_state").length;
    quickJoin(core, 1);

    // The ordinary roster broadcast, not a matchmaking-specific message.
    expect(a!.ofType("room_state").length).toBeGreaterThan(before);
  });

  it("spills into a second room past the seat cap", () => {
    const { core } = newCore();
    const sockets = quickJoin(core, MAX_PLAYERS + 2);
    const roomIds = sockets.map((s) => welcomeOf(s).roomId as string);

    const distinct = new Set(roomIds);
    expect(distinct.size).toBe(2);
    const first = roomIds[0]!;
    expect(roomIds.filter((id) => id === first)).toHaveLength(MAX_PLAYERS);

    // And no seat was handed out twice in the first room.
    const firstRoomSeats = sockets
      .filter((s) => welcomeOf(s).roomId === first)
      .map((s) => welcomeOf(s).playerId);
    expect(new Set(firstRoomSeats).size).toBe(MAX_PLAYERS);
  });

  it("all of a simultaneous burst are seated with no errors", () => {
    const { core } = newCore();
    const sockets = quickJoin(core, 13);
    for (const s of sockets) {
      expect(s.ofType("error")).toEqual([]);
      expect(s.ofType("welcome")).toHaveLength(1);
    }
    // 13 players → 2 full rooms + 1 partial.
    const rooms = new Set(sockets.map((s) => welcomeOf(s).roomId));
    expect(rooms.size).toBe(3);
  });
});

describe("public rooms are not reachable by code over the wire", () => {
  it("the welcome's roomId cannot be used as a join code", () => {
    const { core } = newCore();
    const [seated] = quickJoin(core, 1);
    const code = welcomeOf(seated!).roomId as string;

    const intruder = connect(core);
    intruder.receiveMsg(joinByCode(code));

    expect(intruder.ofType("welcome")).toEqual([]);
    expect(intruder.lastOf("error")?.code).toBe("unknown-room");
  });

  it("gives the identical error as a code that never existed", () => {
    const { core } = newCore();
    const [seated] = quickJoin(core, 1);
    const publicCode = welcomeOf(seated!).roomId as string;

    const atPublic = connect(core);
    atPublic.receiveMsg(joinByCode(publicCode));
    const atNothing = connect(core);
    atNothing.receiveMsg(joinByCode("ZZZZ"));

    expect(atPublic.lastOf("error")).toEqual(atNothing.lastOf("error"));
  });

  it("private rooms still join by code exactly as before", () => {
    const { core } = newCore();
    const host = connect(core);
    host.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const code = welcomeOf(host).roomId as string;

    const friend = connect(core);
    friend.receiveMsg(joinByCode(code));

    expect(friend.ofType("error")).toEqual([]);
    expect(welcomeOf(friend).playerId).toBe("p1");
  });
});

describe("a matchmade room plays like any other", () => {
  // TASK 28 — public rooms lost the player-initiated start entirely.
  // These two cases used to assert "the host may start, a guest may
  // not"; the rule is now "NOBODY may start, the server's countdown
  // does". The coverage is kept (and strengthened): both the privileged
  // and unprivileged request are still exercised, and both must be
  // refused without starting anything.
  it("the host can no longer start a matchmade room by hand", () => {
    const { core } = newCore();
    const [host, guest] = quickJoin(core, 2);
    host!.receiveMsg(START);

    expect(host!.lastOf("error")?.code).toBe("unauthorized");
    // Nothing started: no snapshot reached anyone.
    expect(guest!.ofType("snapshot")).toEqual([]);
    expect(host!.ofType("snapshot")).toEqual([]);
  });

  it("a non-host cannot start it either", () => {
    const { core } = newCore();
    const [, guest] = quickJoin(core, 2);
    guest!.receiveMsg(START);

    expect(guest!.lastOf("error")?.code).toBe("unauthorized");
    expect(guest!.ofType("snapshot")).toEqual([]);
  });

  it("the room instead carries a server-armed auto-start deadline", () => {
    // The replacement for the manual start: two seated players are
    // enough for the server to schedule the match by itself.
    const { core, server } = newCore();
    const [a] = quickJoin(core, 2);
    const roomId = welcomeOf(a!).roomId;
    const room = server.getRoom(roomId)!;

    expect(room.state).toBe("waiting");
    expect(room.autoStartDeadline).not.toBeNull();
  });

  it("leaving frees the seat for the next matchmade player", () => {
    const { core } = newCore();
    const [a, b] = quickJoin(core, 2);
    const roomId = welcomeOf(a!).roomId;
    a!.receiveMsg({ protocolVersion: 1, type: "leave_room" });

    const late = connect(core);
    late.receiveMsg(PUBLIC);
    expect(welcomeOf(late).roomId).toBe(roomId);
    expect(welcomeOf(late).playerId).toBe("p0");
    expect(b!.ofType("error")).toEqual([]);
  });
});
