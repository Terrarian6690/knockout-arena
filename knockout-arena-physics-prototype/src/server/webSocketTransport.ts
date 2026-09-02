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
 * Reconnection policy (seat recovery, no gameplay impact): a connection
 * that takes a seat receives an opaque reconnect credential in its
 * personal welcome message. If that socket dies unexpectedly, the seat is
 * RESERVED for a configurable window (default 30s) instead of released —
 * presenting the credential on a new connection reclaims the same seat
 * (same session identity, same playerId, same live match state) and
 * INVALIDATES the old connection. Invalid or expired credentials are
 * rejected indistinguishably. Deliberate shutdown (handle/core close) is
 * not a drop: it disconnects cleanly and revokes the credential.
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
  /**
   * How long a dropped connection's seat stays reserved for reconnect.
   * Only used when this transport creates its own game server; default
   * 30 000 ms (see createGameServer).
   */
  reconnectReservationMs?: number;
}

const DEFAULT_SNAPSHOT_BUFFER_LIMIT = 256 * 1024;

/** One live connection: its session, room membership and bookkeeping. */
interface ConnectionState {
  /**
   * The session bound to this connection. Starts as the socket's own
   * fresh session; a successful reconnect REBINDS it to the recovered
   * session (same identity, same seat). Never leaves the server.
   */
  session: Session;
  readonly socket: TransportSocket;
  roomId: string | null;
  unsubscribeView: (() => void) | null;
  /** match_finished is announced once per match run. */
  finishedAnnounced: boolean;
  closed: boolean;
  /**
   * True once this connection is being deliberately closed (handle/core
   * close): its socket's own close event must not turn into a drop
   * reservation. An explicit server-side close overrides an open one.
   */
  forceClose: boolean;
  /**
   * True once a reconnecting connection took this session over: the
   * socket is being closed for replacement, so its cleanup must neither
   * reserve the seat nor disconnect the (now re-bound) session.
   */
  superseded: boolean;
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
        send(
          state,
          welcomeMessage(
            result.room.id,
            result.playerId,
            result.room,
            result.reconnectToken
          )
        );
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
        send(
          state,
          welcomeMessage(
            result.room.id,
            result.playerId,
            result.room,
            result.reconnectToken
          )
        );
        broadcastRoomState(result.room);
        return;
      }

      case "reconnect": {
        // Seat recovery: present the credential, reclaim the seat. This
        // connection must not already hold a seat (the credential is for
        // a DIFFERENT, dropped connection's seat).
        if (state.roomId !== null) {
          sendError(
            state,
            "already-in-room",
            "this connection already holds a seat — leave it first"
          );
          return;
        }
        const result = gameServer.reconnect(message.token);
        if (!result.ok) {
          sendError(state, result.reason);
          return;
        }
        // Takeover: the recovered session now belongs to THIS connection.
        // Every other connection bound to it is invalidated — closing them
        // must not reserve or disconnect the session (see supersede).
        for (const other of [...connections]) {
          if (
            other !== state &&
            !other.closed &&
            other.session === result.session
          ) {
            supersede(other);
          }
        }
        // Discard the fresh session this socket started with (it never
        // held a seat, so this is a no-op leave) and rebind.
        gameServer.disconnect(state.session);
        state.session = result.session;
        state.roomId = result.room.id;
        state.finishedAnnounced = false;
        subscribeView(state); // pushes the current match state immediately
        send(
          state,
          welcomeMessage(
            result.room.id,
            result.playerId,
            result.room,
            result.reconnectToken
          )
        );
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

  /**
   * Tear down a connection replaced by a reconnect: synchronous unbind
   * (subscription, room membership, registry) + socket close, WITHOUT any
   * server-side session call — the session lives on in the new connection.
   */
  function supersede(state: ConnectionState): void {
    state.superseded = true;
    state.closed = true; // later close/error events become no-ops
    state.unsubscribeView?.();
    state.unsubscribeView = null;
    state.roomId = null;
    connections.delete(state);
    try {
      state.socket.close();
    } catch {
      // already dead — the unbind above is what matters
    }
  }

  /**
   * Idempotent teardown: stop subscriptions, release the session, notify
   * the room. Two modes:
   *
   *   "drop"  — the socket died unexpectedly: the seat gets a reconnect
   *             reservation (identity preserved, seat not stealable) and
   *             the session stays alive until it expires;
   *   "force" — deliberate shutdown of this connection (handle/core
   *             close): clean disconnect, the credential is revoked.
   *
   * Superseded connections (taken over by a reconnect) touch nothing.
   */
  function cleanup(state: ConnectionState, mode: "drop" | "force"): void {
    if (state.closed) return;
    state.closed = true;
    state.unsubscribeView?.();
    state.unsubscribeView = null;
    const roomId = state.roomId;
    state.roomId = null;
    connections.delete(state);
    if (state.superseded) return;
    // A deliberate close wins over the socket's own close event, whatever
    // order they arrive in.
    if (state.forceClose || mode === "force") {
      gameServer.disconnect(state.session);
    } else {
      // Unexpected loss: open the seat's reconnect reservation. A session
      // with no seat has nothing to reserve — clean disconnect instead.
      if (!gameServer.reserve(state.session).ok) {
        gameServer.disconnect(state.session);
      }
    }
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
        forceClose: false,
        superseded: false,
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
      socket.onClose(() => cleanup(state, "drop"));
      socket.onError(() => cleanup(state, "drop"));
      connections.add(state);
      return {
        session: state.session,
        socket,
        close: () => {
          // An explicit close overrides everything — including a
          // reservation a drop already opened.
          if (state.closed) {
            if (!state.superseded) gameServer.disconnect(state.session);
            return;
          }
          state.forceClose = true; // the socket's close event must not reserve
          try {
            socket.close();
          } catch {
            // already dead — cleanup below is idempotent anyway
          }
          cleanup(state, "force");
        },
      };
    },
    close(): void {
      for (const state of [...connections]) {
        state.forceClose = true; // deliberate teardown, not a drop
        try {
          state.socket.close();
        } catch {
          // ignore — cleanup is idempotent
        }
        cleanup(state, "force");
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
  const gameServer =
    options.gameServer ??
    createGameServer({ reconnectReservationMs: options.reconnectReservationMs });
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
