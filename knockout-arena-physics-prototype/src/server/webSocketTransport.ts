import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { createGameServer, type GameServer } from "./gameServer";
import type { Session } from "./session";
import {
  describeError,
  errorMessage,
  matchFinishedMessage,
  parseClientMessage,
  roomStateMessage,
  snapshotMessage,
  welcomeMessage,
} from "./protocol";
import type { RoomInfo } from "./roomManager";

/**
 * WebSocket transport — a pure translator around createGameServer().
 *
 *   wire message  →  server API call      (parseClientMessage + GameServer)
 *   server event  →  wire message         (welcome/room_state/snapshot/…)
 *
 * NO gameplay logic lives here: no engine imports, no state interpretation
 * beyond the room lifecycle facts the protocol itself carries (phase
 * "finished" → match_finished). The socket IS the connection identity; the
 * session token never leaves the server.
 *
 * Authorization policy (v1, deliberately minimal): the room CREATOR is the
 * room host; only the host may start the match (RoomInfo.hostPlayerId,
 * maintained by the RoomManager). reset_match is NOT exposed over the wire
 * at all — resetMatch() stays a server-side operation until rematch
 * authorization is designed.
 *
 * Backpressure policy: snapshots are full-state and high-frequency, so a
 * socket whose outbound buffer exceeds the high-water mark simply does not
 * receive snapshots until it drains — stale intermediates are dropped and
 * the next sent snapshot always carries the newest authoritative state.
 * Commands (inbound) are processed synchronously and never dropped, and the
 * authoritative simulation is never affected by a slow client.
 */

/**
 * The minimal socket surface the transport needs. `ws` sockets are adapted
 * to this shape (see adaptWsSocket); tests drive the same logic with fakes.
 */
export interface TransportSocket {
  send(data: string): void;
  /** Bytes queued but not yet flushed to the network (backpressure signal). */
  readonly bufferedAmount: number;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (error: unknown) => void): void;
  close(): void;
}

export interface TransportOptions {
  /**
   * Per-socket high-water mark in bytes: while a socket has more than this
   * queued, snapshots are dropped for it (the newest state is re-sent once
   * it drains). Default 256 KiB.
   */
  snapshotBufferLimitBytes?: number;
}

const DEFAULT_SNAPSHOT_BUFFER_LIMIT = 256 * 1024;

/** One live connection: its session, room membership and bookkeeping. */
interface ConnectionState {
  readonly session: Session;
  readonly socket: TransportSocket;
  roomId: string | null;
  unsubscribeView: (() => void) | null;
  /** match_finished is announced once per match run. */
  finishedAnnounced: boolean;
  closed: boolean;
}

export interface ConnectionHandle {
  /** The server session bound to this connection (never sent to the client). */
  readonly session: Session;
  readonly socket: TransportSocket;
  /** Close the connection and clean up (idempotent). */
  close(): void;
}

export interface TransportCore {
  /** Bind a socket as a new connection: one Session per socket. */
  attach(socket: TransportSocket): ConnectionHandle;
  /** Tear down every connection (idempotent). */
  close(): void;
}

/**
 * The transport core: connection registry + message routing + broadcasts
 * for one GameServer. Socket-source agnostic — the ws server below feeds it
 * real sockets, tests feed fakes.
 */
export function createTransportCore(
  gameServer: GameServer,
  options: TransportOptions = {}
): TransportCore {
  const snapshotBufferLimit =
    options.snapshotBufferLimitBytes ?? DEFAULT_SNAPSHOT_BUFFER_LIMIT;
  const connections = new Set<ConnectionState>();

  function send(state: ConnectionState, data: string): void {
    if (state.closed) return;
    try {
      state.socket.send(data);
    } catch {
      // A dead socket must never break the broadcast path.
    }
  }

  function sendError(state: ConnectionState, code: string, note?: string): void {
    send(state, errorMessage(code, note ?? describeError(code)));
  }

  /** Broadcast a room_state message to every connection seated in the room. */
  function broadcastRoomState(room: RoomInfo): void {
    for (const connection of connections) {
      if (!connection.closed && connection.roomId === room.id) {
        send(connection, roomStateMessage(room));
      }
    }
  }

  /** (Re)subscribe this connection to its room's viewer-projected states. */
  function subscribeView(state: ConnectionState): void {
    state.unsubscribeView?.();
    state.finishedAnnounced = false;
    state.unsubscribeView = gameServer.onRoomView(state.session, (view) => {
      // Backpressure: while the socket is backed up, drop this full-state
      // snapshot — the next one always carries the newest state.
      if (state.socket.bufferedAmount > snapshotBufferLimit) return;
      send(state, snapshotMessage(view));
      if (view.phase === "finished") {
        if (!state.finishedAnnounced) {
          state.finishedAnnounced = true;
          send(state, matchFinishedMessage(view.winnerId));
        }
      } else {
        state.finishedAnnounced = false;
      }
    });
  }

  function handleWireMessage(state: ConnectionState, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      sendError(state, parsed.code);
      return;
    }
    const message = parsed.message;

    switch (message.type) {
      case "create_room": {
        const result = gameServer.createRoom(state.session);
        if (!result.ok) {
          sendError(state, result.reason);
          return;
        }
        state.roomId = result.room.id;
        subscribeView(state);
        send(state, welcomeMessage(result.room.id, result.playerId, result.room));
        broadcastRoomState(result.room);
        return;
      }

      case "join_room": {
        const result = gameServer.joinRoom(state.session, message.roomId);
        if (!result.ok) {
          sendError(state, result.reason);
          return;
        }
        state.roomId = result.room.id;
        subscribeView(state);
        send(state, welcomeMessage(result.room.id, result.playerId, result.room));
        broadcastRoomState(result.room);
        return;
      }

      case "leave_room": {
        const result = gameServer.leaveRoom(state.session);
        if (!result.ok) {
          sendError(state, result.reason);
          return;
        }
        state.unsubscribeView?.();
        state.unsubscribeView = null;
        state.roomId = null;
        state.finishedAnnounced = false;
        // Notify whoever is left (the room may have been removed entirely).
        if (result.room) broadcastRoomState(result.room);
        return;
      }

      case "start_match": {
        const seat = gameServer.getSeat(state.session);
        if (!seat) {
          sendError(state, "not-in-room");
          return;
        }
        // v1 policy: only the room host (the creator) may start the match.
        if (seat.playerId !== seat.room.hostPlayerId) {
          sendError(state, "unauthorized", "only the room host may start the match");
          return;
        }
        const result = gameServer.startMatch(seat.room.id);
        if (!result.ok) {
          sendError(state, result.reason);
          return;
        }
        broadcastRoomState(result.room);
        return;
      }

      case "command": {
        // Identity comes from the session; the server stamps it and
        // strips whatever the payload claimed.
        const result = gameServer.submitCommand(state.session, message.command);
        if (!result.ok) {
          sendError(state, result.reason);
          return;
        }
        // Success needs no ack: the resulting snapshot follows.
        return;
      }
    }
  }

  /** Idempotent teardown: stop subscriptions, disconnect, notify the room. */
  function cleanup(state: ConnectionState): void {
    if (state.closed) return;
    state.closed = true;
    state.unsubscribeView?.();
    state.unsubscribeView = null;
    const roomId = state.roomId;
    state.roomId = null;
    connections.delete(state);
    gameServer.disconnect(state.session);
    if (roomId) {
      const room = gameServer.getRoom(roomId);
      if (room) broadcastRoomState(room);
    }
  }

  return {
    attach(socket: TransportSocket): ConnectionHandle {
      const state: ConnectionState = {
        session: gameServer.connect(),
        socket,
        roomId: null,
        unsubscribeView: null,
        finishedAnnounced: false,
        closed: false,
      };
      socket.onMessage((data) => {
        try {
          handleWireMessage(state, data);
        } catch {
          // Defense-in-depth: nothing arriving on a socket may take down
          // the connection or the process — reject and keep serving.
          sendError(state, "internal-error");
        }
      });
      socket.onClose(() => cleanup(state));
      socket.onError(() => cleanup(state));
      connections.add(state);
      return {
        session: state.session,
        socket,
        close: () => {
          try {
            socket.close();
          } catch {
            // already dead — cleanup below is idempotent anyway
          }
          cleanup(state);
        },
      };
    },
    close(): void {
      for (const state of [...connections]) {
        try {
          state.socket.close();
        } catch {
          // ignore — cleanup is idempotent
        }
        cleanup(state);
      }
    },
  };
}

// ── the ws server adapter ────────────────────────────────────────────────

export interface WebSocketTransportOptions extends TransportOptions {
  /** Port to listen on; 0 (default) picks a free ephemeral port. */
  port?: number;
  /** Inject an existing game server; by default one is created (and owned). */
  gameServer?: GameServer;
}

export interface WebSocketTransport {
  /** The port the server is listening on. */
  port(): number;
  /** The game server this transport is attached to. */
  gameServer: GameServer;
  /** Stop the server and tear down every connection (idempotent). */
  close(): Promise<void>;
}

/**
 * Start a standalone WebSocket server bound to a GameServer. Resolves once
 * the server is listening. Each connection becomes exactly one Session;
 * closing a socket disconnects it and notifies its room.
 */
export async function createWebSocketTransport(
  options: WebSocketTransportOptions = {}
): Promise<WebSocketTransport> {
  const ownsGameServer = options.gameServer === undefined;
  const gameServer = options.gameServer ?? createGameServer();
  const core = createTransportCore(gameServer, {
    snapshotBufferLimitBytes: options.snapshotBufferLimitBytes,
  });

  const wss = new WebSocketServer({ port: options.port ?? 0 });
  wss.on("connection", (ws) => {
    core.attach(adaptWsSocket(ws));
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (err) => reject(err));
  });

  const address = wss.address();
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    core.close(); // disconnects every session, notifies remaining rooms
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (ownsGameServer) gameServer.destroy();
  }

  return {
    port: () =>
      typeof address === "object" && address !== null
        ? address.port
        : options.port ?? 0,
    gameServer,
    close,
  };
}

/** Adapt a `ws` WebSocket to the transport's minimal socket interface. */
function adaptWsSocket(ws: WebSocket): TransportSocket {
  return {
    send: (data) => {
      ws.send(data);
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onMessage: (cb) => {
      ws.on("message", (raw: RawData) => cb(rawDataToString(raw)));
    },
    onClose: (cb) => {
      ws.on("close", () => cb());
    },
    onError: (cb) => {
      ws.on("error", (err) => cb(err));
    },
    close: () => {
      ws.close();
    },
  };
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  return new TextDecoder().decode(raw);
}
