import { afterEach, describe, expect, it } from "vitest";
import { createNetworkClient, type NetworkClient } from "../websocketClient";
import type { WebSocketFactory, WebSocketLike } from "../types";

/**
 * Network client behavior over FAKE sockets: lifecycle, reconnection,
 * state handling of every server message, sending rules, and the
 * external-store subscription — all without React, DOM or a real server.
 * (The full server↔client loop is pinned in the integration suite.)
 */

/** A controllable fake socket: the test plays the network. */
class FakeWebSocket implements WebSocketLike {
  readonly url: string;
  sent: string[] = [];
  closedByClient = false;
  private firedClose = false;
  private openCbs: Array<() => void> = [];
  private messageCbs: Array<(data: string) => void> = [];
  private errorCbs: Array<() => void> = [];
  private closeCbs: Array<() => void> = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closedByClient = true;
    this.fireClose();
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCbs.push(cb);
  }
  onError(cb: () => void): void {
    this.errorCbs.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  // ── test controls (the "network side") ────────────────────────────────
  serverOpen(): void {
    for (const cb of [...this.openCbs]) cb();
  }
  serverMessage(raw: string): void {
    for (const cb of [...this.messageCbs]) cb(raw);
  }
  serverError(): void {
    for (const cb of [...this.errorCbs]) cb();
  }
  serverClose(): void {
    this.fireClose();
  }
  private fireClose(): void {
    if (this.firedClose) return;
    this.firedClose = true;
    for (const cb of [...this.closeCbs]) cb();
  }
}

/** Wire up a client whose sockets are recorded fakes. */
function makeClient(options: {
  url?: string;
  reconnect?: Record<string, unknown>;
}): { client: NetworkClient; sockets: FakeWebSocket[]; factory: WebSocketFactory } {
  const sockets: FakeWebSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket;
  };
  const client = createNetworkClient({
    // Honor an explicitly absent URL (undefined stays undefined).
    url: "url" in options ? options.url : "ws://test",
    socketFactory: factory,
    reconnect: options.reconnect,
  });
  liveClients.push(client);
  return { client, sockets, factory };
}

/** Connect and complete the (fake) handshake. */
function connectedClient(options: { reconnect?: Record<string, unknown> } = {}) {
  const harness = makeClient(options);
  harness.client.connect();
  harness.sockets[0].serverOpen();
  return harness;
}

const wire = {
  welcome: (playerId: string, roomId = "r1") =>
    JSON.stringify({
      protocolVersion: 1,
      type: "welcome",
      roomId,
      playerId,
      roomState: "waiting",
      roster: [{ playerId: "p0", connected: true }, { playerId: "p1", connected: true }],
      hostPlayerId: "p0",
    }),
  roomState: (roomState: string, roster: unknown[] = [{ playerId: "p0", connected: true }]) =>
    JSON.stringify({
      protocolVersion: 1,
      type: "room_state",
      roomId: "r1",
      roomState,
      roster,
      hostPlayerId: "p0",
    }),
  snapshot: (phase: string, localPawnId: string) =>
    JSON.stringify({
      protocolVersion: 1,
      type: "snapshot",
      state: {
        phase,
        pawns: [{ id: localPawnId, isLocal: true }],
        localPawnId,
        winnerId: phase === "finished" ? "p1" : null,
        power: 3,
        aimDirection: null,
        isAiming: false,
        activePawnId: "p0",
      },
    }),
  matchFinished: (winnerId: string | null) =>
    JSON.stringify({ protocolVersion: 1, type: "match_finished", winnerId }),
  error: (code: string, message = "nope") =>
    JSON.stringify({ protocolVersion: 1, type: "error", code, message }),
};

const liveClients: NetworkClient[] = [];
afterEach(() => {
  for (const client of liveClients.splice(0)) client.close();
});

// ────────────────────────────────────────────────────────────────────────
// Connection lifecycle
// ────────────────────────────────────────────────────────────────────────

describe("connection lifecycle", () => {
  it("starts disconnected with empty state", () => {
    const { client } = makeClient({});
    expect(client.getState()).toEqual({
      status: "disconnected",
      roomId: null,
      playerId: null,
      roomState: null,
      roster: [],
      hostPlayerId: null,
      snapshot: null,
      winnerId: null,
      lastError: null,
      reconnectAttempt: 0,
    });
  });

  it("connect() creates exactly one socket and becomes connected on open", () => {
    const { client, sockets } = makeClient({});
    expect(client.connect()).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(client.getState().status).toBe("connecting");

    sockets[0].serverOpen();
    expect(client.getState().status).toBe("connected");
  });

  it("connect() without a URL is a clean no-op", () => {
    const { client, sockets } = makeClient({ url: undefined });
    expect(client.connect()).toBe(false);
    expect(sockets).toHaveLength(0);
    expect(client.getState().status).toBe("disconnected");
  });

  it("duplicate connect() never creates a second socket", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    expect(client.connect()).toBe(false); // already connected
    expect(client.connect()).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it("close() is permanent and idempotent", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    client.close();
    client.close(); // idempotent
    expect(client.getState().status).toBe("closed");
    expect(sockets[0].closedByClient).toBe(true);
    expect(client.connect()).toBe(false); // terminal — no revival
    expect(sockets).toHaveLength(1);
  });

  it("explicit close never reconnects", async () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    client.close();
    // The (already-nulled) socket's close event must not trigger a retry.
    await new Promise((r) => setTimeout(r, 30));
    expect(client.getState().status).toBe("closed");
    expect(sockets).toHaveLength(1);
  });

  it("an unexpected disconnect enters reconnecting and clears the seat", () => {
    const { client, sockets } = makeClient({ reconnect: { baseDelayMs: 1000 } });
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverMessage(wire.welcome("p1"));

    sockets[0].serverClose(); // the network drops us
    const state = client.getState();
    expect(state.status).toBe("reconnecting");
    expect(state.reconnectAttempt).toBe(1);
    // The seat does NOT survive the connection — nothing pretends it does.
    expect(state.roomId).toBeNull();
    expect(state.playerId).toBeNull();
    expect(state.roomState).toBeNull();
    expect(state.roster).toEqual([]);
    expect(state.snapshot).toBeNull();
  });

  it("reconnect attempts are bounded when the server stays unreachable", async () => {
    const { client, sockets } = makeClient({
      reconnect: { maxAttempts: 2, baseDelayMs: 1, backoffFactor: 1 },
    });
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverClose(); // drop 1 → retry 1 (the server is now down)

    // Every retry fails: the new socket closes without ever opening.
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets).toHaveLength(2);
    sockets[1].serverClose(); // retry 1 failed → retry 2
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets).toHaveLength(3);
    sockets[2].serverClose(); // retry 2 failed → attempts exhausted
    await new Promise((r) => setTimeout(r, 20));

    const state = client.getState();
    expect(state.status).toBe("disconnected");
    expect(state.reconnectAttempt).toBe(0); // reset: a manual connect() can work
    expect(sockets).toHaveLength(3); // bounded: initial + 2 retries, no more

    // A later manual connect() starts fresh.
    expect(client.connect()).toBe(true);
    expect(sockets).toHaveLength(4);
  });

  it("reconnects successfully with a fresh session and working sends", async () => {
    const { client, sockets } = makeClient({
      reconnect: { maxAttempts: 3, baseDelayMs: 1 },
    });
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverMessage(wire.welcome("p1"));
    sockets[0].serverClose();

    await new Promise((r) => setTimeout(r, 10));
    expect(sockets).toHaveLength(2);
    sockets[1].serverOpen();
    const state = client.getState();
    expect(state.status).toBe("connected");
    expect(state.reconnectAttempt).toBe(0);
    // The reconnected session is NOT the old seat — a new room must be
    // requested explicitly, never created automatically.
    expect(state.roomId).toBeNull();
    expect(client.createRoom()).toBe(true);
    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      protocolVersion: 1,
      type: "create_room",
    });
  });

  it("reconnection can be disabled", async () => {
    const { client, sockets } = makeClient({ reconnect: { enabled: false } });
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverClose();
    expect(client.getState().status).toBe("disconnected");
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(1);
  });

  it("commands are not sent while disconnected or connecting", () => {
    const { client, sockets } = makeClient({});
    expect(client.createRoom()).toBe(false);
    expect(client.joinRoom("r1")).toBe(false);
    expect(client.leaveRoom()).toBe(false);
    expect(client.startMatch()).toBe(false);
    expect(client.submitCommand({ type: "aim", x: 1, y: 2 })).toBe(false);
    expect(sockets[0]?.sent ?? []).toHaveLength(0);

    client.connect(); // connecting (handshake not complete)
    expect(client.createRoom()).toBe(false);
    expect(sockets[0].sent).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Server message handling
// ────────────────────────────────────────────────────────────────────────

describe("server message handling", () => {
  it("welcome assigns the server-given room, seat and roster", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverMessage(wire.welcome("p1"));

    const state = client.getState();
    expect(state.roomId).toBe("r1");
    expect(state.playerId).toBe("p1"); // server-assigned, never chosen
    expect(state.roomState).toBe("waiting");
    expect(state.roster).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: true },
    ]);
    expect(state.hostPlayerId).toBe("p0");
  });

  it("room_state updates the room picture", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverMessage(
      wire.roomState("playing", [{ playerId: "p0", connected: false }, { playerId: "p1", connected: true }])
    );
    const state = client.getState();
    expect(state.roomState).toBe("playing");
    expect(state.roster).toHaveLength(2);
    expect(state.roster[0]).toEqual({ playerId: "p0", connected: false });
  });

  it("snapshots replace the previous one (no simulation, no merging)", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverMessage(wire.snapshot("aiming", "p0"));
    expect(client.getState().snapshot?.phase).toBe("aiming");
    expect(client.getState().snapshot?.localPawnId).toBe("p0");

    sockets[0].serverMessage(wire.snapshot("moving", "p0"));
    expect(client.getState().snapshot?.phase).toBe("moving");

    // A finished snapshot also carries the winner (still server data).
    sockets[0].serverMessage(wire.snapshot("finished", "p0"));
    expect(client.getState().snapshot?.phase).toBe("finished");
    expect(client.getState().winnerId).toBe("p1");
  });

  it("match_finished records the winner and finished room", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    sockets[0].serverMessage(wire.matchFinished("p1"));
    const state = client.getState();
    expect(state.winnerId).toBe("p1");
    expect(state.roomState).toBe("finished");
  });

  it("error messages are surfaced, never thrown", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    expect(() => sockets[0].serverMessage(wire.error("room-full"))).not.toThrow();
    expect(client.getState().lastError).toEqual({
      code: "room-full",
      message: "nope",
    });
  });

  it("malformed server messages set lastError and never break the client", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    for (const junk of ["{nope", "null", "[]", "42"]) {
      expect(() => sockets[0].serverMessage(junk)).not.toThrow();
    }
    sockets[0].serverMessage(JSON.stringify({ protocolVersion: 1, type: "????" }));
    expect(client.getState().lastError?.code).toBe("unknown-message-type");

    // The connection is unaffected.
    sockets[0].serverMessage(wire.welcome("p0"));
    expect(client.getState().playerId).toBe("p0");
  });

  it("no state mutation after permanent close", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();
    client.close();
    const before = client.getState();

    sockets[0].serverMessage(wire.welcome("p9"));
    sockets[0].serverOpen();
    sockets[0].serverClose();
    expect(client.getState()).toBe(before); // same object, untouched
    expect(before.status).toBe("closed");
  });

  it("stale sockets are ignored after a reconnect", async () => {
    const { client, sockets } = makeClient({
      reconnect: { baseDelayMs: 1 },
    });
    client.connect();
    const first = sockets[0];
    first.serverOpen();
    first.serverClose();
    await new Promise((r) => setTimeout(r, 10));
    sockets[1].serverOpen();

    // A late message from the OLD socket must not touch the state.
    first.serverMessage(wire.welcome("p9"));
    expect(client.getState().playerId).toBeNull();
    expect(client.getState().status).toBe("connected");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Sending
// ────────────────────────────────────────────────────────────────────────

describe("sending protocol messages", () => {
  it("sends create_room, join_room, leave_room and start_match", () => {
    const { client, sockets } = makeClient({});
    client.connect();
    sockets[0].serverOpen();

    expect(client.createRoom()).toBe(true);
    expect(client.joinRoom("r1")).toBe(true);
    expect(client.leaveRoom()).toBe(true);
    expect(client.startMatch()).toBe(true);
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([
      { protocolVersion: 1, type: "create_room" },
      { protocolVersion: 1, type: "join_room", roomId: "r1" },
      { protocolVersion: 1, type: "leave_room" },
      { protocolVersion: 1, type: "start_match" },
    ]);
  });

  it("joinRoom refuses malformed room ids locally", () => {
    const { client, sockets } = connectedClient();
    expect(client.joinRoom("")).toBe(false);
    expect(client.joinRoom(42 as unknown as string)).toBe(false);
    expect(sockets[0].sent).toHaveLength(0);
  });

  it("submitCommand sends intent fields only — no playerId ever", () => {
    const { client, sockets } = connectedClient();
    expect(
      client.submitCommand({ type: "aim", playerId: "p9", x: 10, y: 20, hack: 1 })
    ).toBe(true);
    expect(client.submitCommand({ type: "setPower", power: 4 })).toBe(true);
    expect(client.submitCommand({ type: "confirmLaunch" })).toBe(true);
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([
      { protocolVersion: 1, type: "command", command: { type: "aim", x: 10, y: 20 } },
      { protocolVersion: 1, type: "command", command: { type: "setPower", power: 4 } },
      { protocolVersion: 1, type: "command", command: { type: "confirmLaunch" } },
    ]);
  });

  it("submitCommand refuses reset and junk — nothing is sent", () => {
    const { client, sockets } = connectedClient();
    expect(client.submitCommand({ type: "reset" })).toBe(false);
    expect(client.submitCommand({ type: "teleport", x: 0, y: 0 })).toBe(false);
    expect(client.submitCommand(null)).toBe(false);
    expect(sockets[0].sent).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The external store
// ────────────────────────────────────────────────────────────────────────

describe("external-store subscription", () => {
  it("notifies subscribers exactly once per state change", () => {
    const { client, sockets } = connectedClient();
    let notifications = 0;
    const unsubscribe = client.subscribe(() => {
      notifications += 1;
    });

    sockets[0].serverMessage(wire.welcome("p0"));
    expect(notifications).toBe(1); // one message → one notification
    sockets[0].serverMessage(wire.roomState("playing"));
    expect(notifications).toBe(2);
    unsubscribe();
    sockets[0].serverMessage(wire.error("x"));
    expect(notifications).toBe(2); // no more after unsubscribe
  });

  it("getState is referentially stable between changes (useSyncExternalStore-safe)", () => {
    const { client, sockets } = connectedClient();
    const before = client.getState();
    sockets[0].serverMessage(wire.welcome("p0"));
    const after = client.getState();
    expect(after).not.toBe(before); // changed → new object
    expect(client.getState()).toBe(after); // unchanged → same reference
  });

  it("a broken subscriber cannot break the client", () => {
    const { client, sockets } = connectedClient();
    client.subscribe(() => {
      throw new Error("subscriber bug");
    });
    expect(() => sockets[0].serverMessage(wire.welcome("p0"))).not.toThrow();
    expect(client.getState().playerId).toBe("p0");
  });
});
