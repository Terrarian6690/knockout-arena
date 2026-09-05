import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import {
  createGameServer,
  createTransportCore,
  type ConnectionHandle,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";
import { isValidRoomCode } from "../roomCode";

/**
 * Transport behavior over FAKE sockets — the same connection logic the real
 * ws server runs (createTransportCore), driven deterministically without
 * networking. Real-socket end-to-end coverage lives in
 * transport.e2e.test.ts; the protocol contract itself lives in protocol.ts.
 *
 * What these tests pin: the connection/session lifecycle, the full wire
 * protocol (validation + routing), room operations, identity (server-assigned
 * seats, forged playerIds ignored), snapshot broadcast with viewer-local
 * projection, host-only start authorization, disconnect cleanup, and the
 * backpressure policy.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── fake socket ───────────────────────────────────────────────────────────

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

  /** Test helper: deliver one inbound wire message. */
  receive(raw: string): void {
    for (const cb of [...this.messageHandlers]) cb(raw);
  }
  /** Test helper: receive a ready-made message object. */
  receiveMsg(message: unknown): void {
    this.receive(JSON.stringify(message));
  }
  /** Test helper: parsed outbound messages. */
  json(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  /** Test helper: outbound messages of a given type. */
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
function newCore(options?: { snapshotBufferLimitBytes?: number }): {
  server: GameServer;
  core: TransportCore;
} {
  const server = createGameServer();
  liveServers.push(server);
  return { server, core: createTransportCore(server, options) };
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

/** A connected client: fake socket + handle. */
function connect(core: TransportCore): { socket: FakeSocket; handle: ConnectionHandle } {
  const socket = new FakeSocket();
  const handle = core.attach(socket);
  return { socket, handle };
}

const msg = {
  create: { protocolVersion: 1, type: "create_room" },
  leave: { protocolVersion: 1, type: "leave_room" },
  start: { protocolVersion: 1, type: "start_match" },
};

function join(roomId: string) {
  return { protocolVersion: 1, type: "join_room", roomId };
}

function command(command: unknown) {
  return { protocolVersion: 1, type: "command", command };
}

/** A room with n connected clients; creator first. */
function makeRoom(core: TransportCore, n: number): {
  roomId: string;
  sockets: FakeSocket[];
  handles: ConnectionHandle[];
} {
  const sockets: FakeSocket[] = [];
  const handles: ConnectionHandle[] = [];
  const creator = connect(core);
  creator.socket.receiveMsg(msg.create);
  const welcome = creator.socket.lastOf("welcome") as { roomId: string };
  sockets.push(creator.socket);
  handles.push(creator.handle);
  for (let i = 1; i < n; i++) {
    const member = connect(core);
    member.socket.receiveMsg(join(welcome.roomId));
    sockets.push(member.socket);
    handles.push(member.handle);
  }
  return { roomId: welcome.roomId, sockets, handles };
}

/** Start a match as the room host (sockets[0] is the creator). */
function startAsHost(socket: FakeSocket) {
  socket.receiveMsg(msg.start);
}

/** Poll until a condition holds (real match progression via the 60 Hz loop). */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ────────────────────────────────────────────────────────────────────────
// Connection & session lifecycle
// ────────────────────────────────────────────────────────────────────────

describe("connection lifecycle", () => {
  it("creates exactly one session per socket connection", () => {
    const { server, core } = newCore();
    connect(core);
    connect(core);
    expect(server.sessionCount()).toBe(2);
  });

  it("never exposes the session token on the wire", () => {
    const { core } = newCore();
    const { socket, handle } = connect(core);
    socket.receiveMsg(msg.create);
    expect(handle.session.token).toBeTruthy();
    for (const raw of socket.sent) {
      expect(raw).not.toContain(handle.session.token);
    }
  });

  it("socket close disconnects the session (idempotent cleanup)", () => {
    const { server, core } = newCore();
    const { socket } = connect(core);
    socket.close();
    socket.close(); // duplicate close event — harmless
    expect(server.sessionCount()).toBe(0);
  });

  it("programmatic connection close is idempotent too", () => {
    const { server, core } = newCore();
    const { socket, handle } = connect(core);
    handle.close();
    handle.close();
    socket.close();
    expect(server.sessionCount()).toBe(0);
    expect(socket.sent.length).toBe(0); // closed sockets receive nothing
  });

  it("commands after disconnect are impossible (no socket, no session)", () => {
    const { server, core } = newCore();
    const { socket, handle } = connect(core);
    socket.receiveMsg(msg.create);
    handle.close();
    expect(server.sessionCount()).toBe(0);
    // Even a message delivered post-close is ignored (closed connections
    // do not route), and the session is gone server-side.
    socket.receiveMsg(msg.leave);
    expect(server.roomCount()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Protocol validation — the untrusted boundary
// ────────────────────────────────────────────────────────────────────────

describe("protocol validation", () => {
  it("accepts protocolVersion 1", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg(msg.create);
    expect(socket.lastOf("welcome")).toMatchObject({ playerId: "p0" });
  });

  it("rejects unsupported and missing protocolVersion", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg({ protocolVersion: 2, type: "create_room" });
    expect(socket.lastOf("error")).toMatchObject({ code: "unsupported-protocol" });
    socket.receiveMsg({ type: "create_room" }); // missing version
    expect(socket.lastOf("error")).toMatchObject({ code: "unsupported-protocol" });
    socket.receiveMsg({ protocolVersion: "1", type: "create_room" }); // wrong type
    expect(socket.lastOf("error")).toMatchObject({ code: "unsupported-protocol" });
    // The connection stays alive and usable.
    socket.receiveMsg(msg.create);
    expect(socket.lastOf("welcome")).toMatchObject({ playerId: "p0" });
  });

  it("rejects malformed JSON, null, arrays and primitives", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    for (const junk of [
      "{not json",
      "null",
      "[]",
      "[1,2,3]",
      "42",
      '"hello"',
      "true",
      "",
    ]) {
      socket.receive(junk);
      expect(socket.lastOf("error")).toMatchObject({ code: "malformed-message" });
    }
    socket.receiveMsg(msg.create);
    expect(socket.lastOf("welcome")).toMatchObject({ playerId: "p0" });
  });

  it("rejects unknown message types", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg({ protocolVersion: 1, type: "reset_match" }); // deliberately absent
    expect(socket.lastOf("error")).toMatchObject({ code: "unknown-message-type" });
    socket.receiveMsg({ protocolVersion: 1, type: "frobnicate" });
    expect(socket.lastOf("error")).toMatchObject({ code: "unknown-message-type" });
  });

  it("rejects malformed payloads and strict-envelope violations", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg({ protocolVersion: 1, type: "join_room" }); // missing roomId
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg({ protocolVersion: 1, type: "join_room", roomId: 42 });
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg({ protocolVersion: 1, type: "join_room", roomId: "" });
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg({ protocolVersion: 1, type: "create_room", extra: 1 });
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg({ protocolVersion: 1, type: "command" }); // missing command
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg({ protocolVersion: 1, type: "command", command: 42 });
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg({ protocolVersion: 1, type: "command", command: [] });
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    // Still alive.
    socket.receiveMsg(msg.create);
    expect(socket.lastOf("welcome")).toMatchObject({ playerId: "p0" });
  });

  it("a well-formed but unknown room id is a clean error, not a crash", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg(join("does-not-exist"));
    expect(socket.lastOf("error")).toMatchObject({ code: "unknown-room" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Room operations over the wire
// ────────────────────────────────────────────────────────────────────────

describe("room operations", () => {
  it("create_room seats the creator as p0 and answers with welcome + room state", () => {
    const { server, core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg(msg.create);

    const welcome = socket.lastOf("welcome")!;
    expect(welcome).toMatchObject({
      protocolVersion: 1,
      type: "welcome",
      playerId: "p0",
      roomState: "waiting",
      hostPlayerId: "p0",
    });
    expect(typeof welcome.roomId).toBe("string");
    expect(welcome.roster).toEqual([{ playerId: "p0", connected: true }]);

    const roomState = socket.lastOf("room_state")!;
    expect(roomState).toMatchObject({ type: "room_state", roomState: "waiting" });
    expect(server.roomCount()).toBe(1);
  });

  it("welcome/room_state carry the player-facing room CODE, never the internal id", () => {
    const { server, core } = newCore();
    const creator = connect(core);
    creator.socket.receiveMsg(msg.create);

    const welcome = creator.socket.lastOf("welcome") as { roomId: string };
    // The wire's roomId field now carries the short, human-friendly code.
    expect(isValidRoomCode(welcome.roomId)).toBe(true);
    const room = server.getRoom(welcome.roomId);
    expect(room).not.toBeNull();
    const internalId = room!.id;
    expect(internalId).not.toBe(welcome.roomId);

    // The internal UUID never crosses the wire in any message.
    for (const raw of creator.socket.sent) {
      expect(raw).not.toContain(internalId);
    }
    // room_state broadcasts use the code too.
    const roomState = creator.socket.lastOf("room_state") as { roomId: string };
    expect(roomState.roomId).toBe(welcome.roomId);

    // A second client joins BY CODE over the wire and is welcomed with it.
    const joiner = connect(core);
    joiner.socket.receiveMsg(join(welcome.roomId));
    const joinerWelcome = joiner.socket.lastOf("welcome") as {
      roomId: string;
      playerId: string;
    };
    expect(joinerWelcome).toMatchObject({
      roomId: welcome.roomId,
      playerId: "p1",
    });
    // The joiner's welcome carries the code — and the reconnect credential
    // is a DIFFERENT, opaque string (the code is a locator, not a secret).
    expect(joinerWelcome.roomId).not.toBe(
      (joiner.socket.lastOf("welcome") as { reconnectToken: string }).reconnectToken
    );
    for (const raw of joiner.socket.sent) {
      expect(raw).not.toContain(internalId);
    }
  });

  it("join_room assigns p1/p2/p3 and notifies existing members", () => {
    const { core } = newCore();
    const { roomId, sockets } = makeRoom(core, 3);

    const [creator, joiner1, joiner2] = sockets;
    expect(joiner1.lastOf("welcome")).toMatchObject({ playerId: "p1", roomId });
    expect(joiner2.lastOf("welcome")).toMatchObject({ playerId: "p2", roomId });

    // Every member sees the final roster via room_state broadcasts.
    for (const socket of sockets) {
      const last = socket.lastOf("room_state")!;
      expect(last.roster).toEqual([
        { playerId: "p0", connected: true },
        { playerId: "p1", connected: true },
        { playerId: "p2", connected: true },
      ]);
    }
    // The creator's message log shows the incremental updates.
    expect(creator.ofType("room_state")).toHaveLength(3);
    expect(joiner2.ofType("room_state")).toHaveLength(1); // only its own join
  });

  it("a full room rejects the fifth player", () => {
    const { core } = newCore();
    const { roomId } = makeRoom(core, 4);
    const fifth = connect(core).socket;
    fifth.receiveMsg(join(roomId));
    expect(fifth.lastOf("error")).toMatchObject({ code: "room-full" });
    expect(fifth.lastOf("welcome")).toBeUndefined();
  });

  it("join_room while already in a room is rejected", () => {
    const { core } = newCore();
    const { roomId, sockets } = makeRoom(core, 2);
    sockets[0].receiveMsg(join(roomId));
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "already-in-room" });
    sockets[0].receiveMsg(msg.create);
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "already-in-room" });
  });

  it("leave_room frees the seat and notifies remaining players", () => {
    const { server, core } = newCore();
    const { roomId, sockets } = makeRoom(core, 2);
    sockets[1].receiveMsg(msg.leave);

    // The remaining player is notified with the updated roster.
    const last = sockets[0].lastOf("room_state")!;
    expect(last.roster).toEqual([{ playerId: "p0", connected: true }]);
    expect(server.getRoom(roomId)!.seats).toHaveLength(1);

    // The leaver can create a fresh room afterwards.
    sockets[1].receiveMsg(msg.create);
    expect(sockets[1].lastOf("welcome")).toMatchObject({ playerId: "p0" });
  });

  it("leaving a room you are not in is a clean error", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg(msg.leave);
    expect(socket.lastOf("error")).toMatchObject({ code: "not-in-room" });
  });

  it("multiple independent rooms coexist over one transport", () => {
    const { server, core } = newCore();
    const roomA = makeRoom(core, 2);
    const roomB = makeRoom(core, 3);
    expect(server.roomCount()).toBe(2);
    expect(roomA.roomId).not.toBe(roomB.roomId);

    // A broadcast for room A does not reach room B.
    roomA.sockets[1].receiveMsg(msg.leave);
    expect(roomA.sockets[0].ofType("room_state").length).toBeGreaterThan(0);
    expect(roomB.sockets[0].ofType("room_state")).toHaveLength(3); // its own create + 2 joins only
    expect(roomB.sockets[0].ofType("error")).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Identity & commands
// ────────────────────────────────────────────────────────────────────────

describe("identity and commands", () => {
  it("applies valid commands with the session's identity", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]); // host starts the match

    sockets[0].receiveMsg(command({ type: "aim", x: CX + 100, y: CY }));
    const snapshot = sockets[0].lastOf("snapshot")!;
    const state = snapshot.state as GameStateSnapshot;
    expect(state.isAiming).toBe(true); // the active pawn (p0) has an aim
    expect(state.aimDirection).not.toBeNull();
    expect(state.pawns[0].isLocal).toBe(true); // viewer-local projection
    expect(state.localPawnId).toBe("p0");
  });

  it("a forged playerId in the command payload is ignored", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);

    // p0's socket claims to be p1 — the command is applied to p0's OWN
    // pawn (the seat's identity): accepted, and p0's viewer projection
    // shows p0's aim. Had the payload's playerId been trusted, this would
    // have modified p1's choice.
    sockets[0].receiveMsg(command({ type: "aim", playerId: "p1", x: CX, y: CY }));
    expect(sockets[0].lastOf("error")).toBeUndefined();
    const state = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(state.localPawnId).toBe("p0");
    expect(state.isAiming).toBe(true); // p0's own aim (forged id ignored)
    expect(state.pawns[1].isLocal).toBe(false);

    // Ownership is enforced for the REAL owner the other way too: p1's
    // socket claiming to be p0 acts on p1's own pawn (rounds are
    // simultaneous, so p1 acting is legal — but never on p0's pawn).
    sockets[1].receiveMsg(command({ type: "aim", playerId: "p0", x: CX, y: CY }));
    expect(sockets[1].lastOf("error")).toBeUndefined();
    const p1View = sockets[1].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(p1View.localPawnId).toBe("p1");
    expect(p1View.isAiming).toBe(true); // p1's own aim, not p0's
  });

  it("setPower and confirmLaunch work through the wire", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);

    sockets[0].receiveMsg(command({ type: "setPower", power: 5 }));
    let state = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(state.power).toBe(5); // the viewer's own power

    sockets[0].receiveMsg(command({ type: "confirmLaunch" }));
    state = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(state.phase).toBe("aiming"); // the round waits for p1…
    expect(state.pawns[0].confirmed).toBe(true); // …but p0's choice is locked

    // p1 confirms too → the round resolves with both movements together.
    sockets[1].receiveMsg(command({ type: "confirmLaunch" }));
    state = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(state.phase).toBe("moving");

    // confirmLaunch again while moving: wrong phase.
    sockets[0].receiveMsg(command({ type: "confirmLaunch" }));
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "wrong-phase" });
  });

  it("commands in a waiting room / without a room are rejected", () => {
    const { core } = newCore();
    const roomless = connect(core).socket;
    roomless.receiveMsg(command({ type: "aim", x: CX, y: CY }));
    expect(roomless.lastOf("error")).toMatchObject({ code: "not-in-room" });

    const { sockets } = makeRoom(core, 2); // still waiting
    sockets[0].receiveMsg(command({ type: "aim", x: CX, y: CY }));
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "no-match" });
  });

  it("malformed commands and disguised GameStates are rejected", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);

    const snapshotCount = sockets[0].ofType("snapshot").length;
    for (const bad of [
      { type: "aim", x: "no", y: 1 },
      { type: "aim", x: NaN, y: 1 },
      { type: "teleport", x: 0, y: 0 },
    ]) {
      sockets[0].receiveMsg(command(bad));
      expect(sockets[0].lastOf("error")).toMatchObject({ code: "invalid-command" });
    }

    // A full authoritative GameState disguised as a command: rejected, and
    // the authoritative state does not change.
    const disguised = sockets[0].lastOf("snapshot")!.state;
    sockets[1].receiveMsg(command(disguised));
    expect(sockets[1].lastOf("error")).toMatchObject({ code: "invalid-command" });
    expect(sockets[0].ofType("snapshot").length).toBe(snapshotCount);
  });

  it("reset is not exposed over the wire", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);

    // Not as a command…
    sockets[0].receiveMsg(command({ type: "reset" }));
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "unauthorized" });
    // …and not as a message type.
    sockets[0].receiveMsg({ protocolVersion: 1, type: "reset_match" });
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "unknown-message-type" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Snapshots, projection and match lifecycle
// ────────────────────────────────────────────────────────────────────────

describe("snapshots and match lifecycle", () => {
  it("broadcasts viewer-projected snapshots to every member", async () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);

    // Both members receive the initial match snapshot…
    await waitFor(() => sockets[0].ofType("snapshot").length > 0 && sockets[1].ofType("snapshot").length > 0, 2000);
    const asP0 = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    const asP1 = sockets[1].lastOf("snapshot")!.state as GameStateSnapshot;

    // …each projected for THEIR pawn (same authoritative state, local flags differ).
    expect(asP0.localPawnId).toBe("p0");
    expect(asP1.localPawnId).toBe("p1");
    expect(asP0.pawns.map((p) => p.id)).toEqual(asP1.pawns.map((p) => p.id));
    expect(asP0.pawns[0].isLocal).toBe(true);
    expect(asP1.pawns[0].isLocal).toBe(false);
    expect(asP1.pawns[1].isLocal).toBe(true);

    // A state change reaches every member.
    const before = sockets[1].ofType("snapshot").length;
    sockets[0].receiveMsg(command({ type: "aim", x: CX, y: CY }));
    expect(sockets[0].ofType("snapshot").length).toBeGreaterThan(before);
    expect(sockets[1].ofType("snapshot").length).toBeGreaterThan(before);
    const p0View = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(p0View.isAiming).toBe(true); // p0 sees its OWN aim…
    const p1View = sockets[1].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(p1View.isAiming).toBe(false); // …p1's controls stay neutral until p1 aims
    expect(p1View.pawns[0].isLocal).toBe(false);
    expect(p1View.pawns.map((p) => p.id)).toEqual(p0View.pawns.map((p) => p.id));
  }, 5000);

  it("roomless and other-room connections receive no snapshots", async () => {
    const { core } = newCore();
    const outsider = connect(core).socket;
    const roomA = makeRoom(core, 2);
    const roomB = makeRoom(core, 2);
    startAsHost(roomA.sockets[0]);

    await waitFor(() => roomA.sockets[0].ofType("snapshot").length > 0, 2000);
    expect(roomA.sockets[0].ofType("snapshot").length).toBeGreaterThan(0);
    expect(roomA.sockets[1].ofType("snapshot").length).toBeGreaterThan(0);
    expect(roomB.sockets[0].ofType("snapshot")).toHaveLength(0);
    expect(roomB.sockets[1].ofType("snapshot")).toHaveLength(0);
    expect(outsider.sent).toHaveLength(0);
  }, 5000);

  it("announces match_finished once, with the winner", async () => {
    const { server, core } = newCore();
    const { roomId, sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);

    // p0 eliminates itself (radial outward power-5 launch over the rim).
    await waitFor(() => sockets[0].ofType("snapshot").length > 0, 2000);
    const me = (sockets[0].lastOf("snapshot")!.state as GameStateSnapshot).pawns[0];
    const dx = me.position.x - CX || 1;
    const dy = me.position.y - CY;
    const len = Math.hypot(dx, dy) || 1;
    sockets[0].receiveMsg(command({ type: "aim", x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 }));
    sockets[0].receiveMsg(command({ type: "setPower", power: 5 }));
    sockets[0].receiveMsg(command({ type: "confirmLaunch" }));
    server.resolveRound(roomId); // the decision deadline (p1 stayed silent)

    const done = await waitFor(
      () => sockets[1].ofType("match_finished").length > 0,
      5000
    );
    expect(done).toBe(true);
    expect(sockets[1].lastOf("match_finished")).toMatchObject({ winnerId: "p1" });
    // Exactly one announcement per member…
    expect(sockets[1].ofType("match_finished")).toHaveLength(1);
    // …and the final snapshot is finished too.
    const final = sockets[1].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(final.phase).toBe("finished");
    expect(final.winnerId).toBe("p1");
  }, 8000);
});

// ────────────────────────────────────────────────────────────────────────
// Authorization
// ────────────────────────────────────────────────────────────────────────

describe("start-match authorization (v1: creator is host)", () => {
  it("the host (creator) starts the match", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);
    const last = sockets[0].lastOf("room_state")!;
    expect(last).toMatchObject({ roomState: "playing" });
  });

  it("non-hosts cannot start the match", () => {
    const { server, core } = newCore();
    const { roomId, sockets } = makeRoom(core, 2);
    sockets[1].receiveMsg(msg.start);
    expect(sockets[1].lastOf("error")).toMatchObject({ code: "unauthorized" });
    expect(server.getRoom(roomId)!.state).toBe("waiting"); // untouched
    // The host still can.
    startAsHost(sockets[0]);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  });

  it("start_match without a room is rejected", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg(msg.start);
    expect(socket.lastOf("error")).toMatchObject({ code: "not-in-room" });
  });

  it("a room whose host left has no host — nobody may start", () => {
    const { server, core } = newCore();
    const { roomId, sockets } = makeRoom(core, 2);
    sockets[0].receiveMsg(msg.leave); // the creator leaves the waiting room
    expect(server.getRoom(roomId)!.hostPlayerId).toBeNull();
    sockets[1].receiveMsg(msg.start);
    expect(sockets[1].lastOf("error")).toMatchObject({ code: "unauthorized" });
  });

  it("starting twice is rejected", () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);
    sockets[0].receiveMsg(msg.start);
    expect(sockets[0].lastOf("error")).toMatchObject({ code: "already-playing" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Disconnect
// ────────────────────────────────────────────────────────────────────────

describe("disconnect", () => {
  it("a mid-flight disconnect vacates the seat and the match still resolves", async () => {
    const { server, core } = newCore();
    const { roomId, sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);
    await waitFor(() => sockets[1].ofType("snapshot").length > 0, 2000);

    // p0 launches itself over the rim, then disconnects mid-flight.
    const me = (sockets[0].lastOf("snapshot")!.state as GameStateSnapshot).pawns[0];
    const dx = me.position.x - CX || 1;
    const dy = me.position.y - CY;
    const len = Math.hypot(dx, dy) || 1;
    sockets[0].receiveMsg(command({ type: "aim", x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 }));
    sockets[0].receiveMsg(command({ type: "setPower", power: 5 }));
    sockets[0].receiveMsg(command({ type: "confirmLaunch" }));
    // The deadline fires and p0 drops while its pawn is mid-flight: the
    // confirmed move executes without its connection.
    server.resolveRound(roomId);
    sockets[0].close();

    // The remaining player is notified (p0 vacated, roster frozen)…
    const last = sockets[1].lastOf("room_state")!;
    expect(last.roster).toEqual([
      { playerId: "p0", connected: false },
      { playerId: "p1", connected: true },
    ]);
    // …and the GameHost keeps running: snapshots keep flowing and the match
    // resolves to a winner without the disconnected player.
    const done = await waitFor(
      () => sockets[1].ofType("match_finished").length > 0,
      5000
    );
    expect(done).toBe(true);
    expect(sockets[1].lastOf("match_finished")).toMatchObject({ winnerId: "p1" });
    expect(server.getRoom(roomId)!.state).toBe("finished");
  }, 8000);

  it("drops reserve the seats; force-closing an emptied room cleans it up", () => {
    const { server, core } = newCore();
    const roomA = makeRoom(core, 2);
    const roomB = makeRoom(core, 2);

    // Unexpected socket loss: both seats are RESERVED (reported
    // disconnected, room alive — identity recoverable), not released.
    roomA.sockets[0].close();
    roomA.sockets[1].close();
    expect(server.getRoom(roomA.roomId)).not.toBeNull();
    expect(server.getRoom(roomA.roomId)!.seats).toEqual([
      { playerId: "p0", connected: false, displayName: null },
      { playerId: "p1", connected: false, displayName: null },
    ]);
    expect(server.sessionCount()).toBe(4); // reservations keep sessions

    // Explicit server-side teardown overrides the reservations: the
    // emptied room is removed, unrelated rooms stay untouched.
    roomA.handles[0].close();
    roomA.handles[1].close();
    expect(server.getRoom(roomA.roomId)).toBeNull();
    expect(server.roomCount()).toBe(1);
    expect(server.getRoom(roomB.roomId)!.seats).toHaveLength(2);
  });

  it("tearing down the whole transport disconnects everyone", () => {
    const { server, core } = newCore();
    makeRoom(core, 2);
    makeRoom(core, 2);
    expect(server.sessionCount()).toBe(4);
    core.close();
    core.close(); // idempotent
    expect(server.sessionCount()).toBe(0);
    expect(server.roomCount()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Backpressure
// ────────────────────────────────────────────────────────────────────────

describe("backpressure (slow clients)", () => {
  it("drops snapshots for a backed-up socket but keeps it commanding", async () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 2);
    startAsHost(sockets[0]);
    await waitFor(() => sockets[0].ofType("snapshot").length > 0, 2000);

    // The healthy member's baseline.
    const healthyBefore = sockets[1].ofType("snapshot").length;
    const slowBefore = sockets[0].ofType("snapshot").length;

    // p0's socket is now "slow": its outbound buffer is over the limit.
    sockets[0].bufferedAmount = 10 * 1024 * 1024;
    sockets[0].receiveMsg(command({ type: "aim", x: CX, y: CY }));

    // The command WAS processed (authoritative state changed — the healthy
    // member receives the broadcast)…
    expect(sockets[1].ofType("snapshot").length).toBeGreaterThan(healthyBefore);
    // …but the slow socket received no snapshot for it (dropped, not queued)
    // — its newest view still predates the aim.
    expect(sockets[0].ofType("snapshot").length).toBe(slowBefore);
    const staleView = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(staleView.isAiming).toBe(false); // p0's own view, pre-aim

    // Once the socket drains, the NEWEST authoritative state arrives with
    // the next snapshot — nothing stale is replayed.
    sockets[0].bufferedAmount = 0;
    sockets[0].receiveMsg(command({ type: "setPower", power: 3 }));
    const state = sockets[0].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(state.isAiming).toBe(true); // the earlier aim
    expect(state.power).toBe(3); // and the newer power — newest state
  }, 5000);

  it("a slow socket never blocks the healthy members' broadcast", async () => {
    const { core } = newCore();
    const { sockets } = makeRoom(core, 3);
    startAsHost(sockets[0]);
    await waitFor(() => sockets[2].ofType("snapshot").length > 0, 2000);

    // One member is wedged…
    sockets[1].bufferedAmount = 100 * 1024 * 1024;
    // …yet the host's command is applied and broadcast to healthy members
    // synchronously, and the wedged member's inbound command still works.
    sockets[0].receiveMsg(command({ type: "aim", x: CX, y: CY }));
    sockets[0].receiveMsg(command({ type: "confirmLaunch" })); // visible to everyone
    sockets[1].receiveMsg(command({ type: "setPower", power: 2 })); // still answered (rounds are open to all)
    expect(sockets[1].lastOf("error")).toBeUndefined();
    const view = sockets[2].lastOf("snapshot")!.state as GameStateSnapshot;
    expect(view.pawns[0].confirmed).toBe(true); // the healthy member saw p0 lock in
  }, 5000);
});
