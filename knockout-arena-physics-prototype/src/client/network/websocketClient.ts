import {
  commandMessage,
  createRoomMessage,
  joinRoomMessage,
  leaveRoomMessage,
  parseServerMessage,
  startMatchMessage,
} from "./protocolClient";
import {
  DEFAULT_RECONNECT_POLICY,
  type NetworkClientState,
  type ReconnectPolicy,
  type WebSocketFactory,
  type WebSocketLike,
} from "./types";

/**
 * The browser-side multiplayer client — a thin, NON-authoritative view of
 * the server.
 *
 * Responsibilities (and nothing else):
 *   - own one WebSocket connection and its lifecycle;
 *   - translate UI intents into protocol-v1 wire messages;
 *   - translate incoming wire messages into client state;
 *   - expose that state through an external-store subscription
 *     (getState + subscribe — the exact contract of React's
 *     useSyncExternalStore, so no WebSocket ever lands inside a component);
 *   - retry with bounded backoff after unexpected drops.
 *
 * What it must NEVER do (and doesn't): run a simulation, call the engine,
 * compute winners/eliminations, trust a playerId from anywhere but the
 * server's welcome, or create a second game-state shape. The browser only
 * renders what the server sends.
 *
 * Reconnection honesty: there is no server-side seat-reconnection protocol
 * yet, so a reconnect is a FRESH session — the previous room/seat state is
 * cleared on disconnect (never pretended to survive), no room is created
 * automatically, and commands are never sent while not connected. The
 * ReconnectPolicy exists so this can be swapped for real reconnection later.
 */

export interface NetworkClientOptions {
  /** Default server URL (connect(url) overrides it). */
  url?: string;
  /** Socket source; defaults to the browser WebSocket adapter. */
  socketFactory?: WebSocketFactory;
  /** Overrides for the reconnection policy. */
  reconnect?: Partial<ReconnectPolicy>;
}

export interface NetworkClient {
  /** Current state snapshot (referentially stable between changes). */
  getState(): NetworkClientState;
  /** External-store subscription; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Open the connection. Returns false (and does nothing) when a connection
   * is already in flight, when the client was permanently closed, or when
   * no URL is known. Never creates a second socket for one connection.
   */
  connect(url?: string): boolean;
  /** Close permanently. Idempotent; never triggers reconnection. */
  close(): void;
  createRoom(): boolean;
  joinRoom(roomId: string): boolean;
  leaveRoom(): boolean;
  startMatch(): boolean;
  /**
   * Send a player intent. Only the intent fields required by protocol v1
   * are transmitted — any playerId or unknown field is dropped here, and
   * `reset` (a server-only operation) is refused outright.
   */
  submitCommand(intent: unknown): boolean;
}

export function createNetworkClient(options: NetworkClientOptions = {}): NetworkClient {
  const factory: WebSocketFactory = options.socketFactory ?? browserSocketFactory;
  const reconnect: ReconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...options.reconnect,
  };

  let state: NetworkClientState = {
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
  };
  const listeners = new Set<() => void>();

  let url: string | null = options.url ?? null;
  let socket: WebSocketLike | null = null;
  let closedForever = false;
  let pendingReconnect: ReturnType<typeof setTimeout> | null = null;

  function setState(patch: Partial<NetworkClientState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken subscriber must never break the client.
      }
    }
  }

  function clearRoomState(): void {
    // The seat does not survive the connection — clear instead of pretending.
    setState({
      roomId: null,
      playerId: null,
      roomState: null,
      roster: [],
      hostPlayerId: null,
      snapshot: null,
      winnerId: null,
    });
  }

  function openSocket(isRetry: boolean): boolean {
    let ws: WebSocketLike;
    try {
      ws = factory(url as string);
    } catch {
      // No usable WebSocket implementation (or a broken factory): report
      // failure instead of crashing the caller — the status stays whatever
      // it was, so a manual connect() can be retried later.
      return false;
    }
    socket = ws;
    setState({ status: isRetry ? "reconnecting" : "connecting" });

    ws.onOpen(() => {
      if (socket !== ws) return; // stale socket
      setState({ status: "connected", reconnectAttempt: 0 });
    });
    ws.onMessage((data) => {
      if (socket !== ws) return;
      handleServerMessage(data);
    });
    ws.onError(() => {
      // The platform always follows onerror with onclose; the close handler
      // owns the transition so nothing is processed twice.
    });
    ws.onClose(() => {
      if (socket !== ws) return;
      socket = null;
      handleDisconnect();
    });

    return true;
  }

  function handleServerMessage(raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      // Malformed server input is surfaced, never thrown, and never kills
      // the connection handling.
      setState({ lastError: { code: parsed.code, message: parsed.description } });
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "welcome":
        setState({
          roomId: message.roomId,
          playerId: message.playerId,
          roomState: message.roomState,
          roster: message.roster,
          hostPlayerId: message.hostPlayerId,
        });
        return;
      case "room_state":
        setState({
          roomId: message.roomId ?? state.roomId,
          roomState: message.roomState,
          roster: message.roster,
          hostPlayerId: message.hostPlayerId,
        });
        return;
      case "snapshot":
        // The authoritative state REPLACES whatever we had — no local
        // simulation, no merging, no extrapolation.
        setState({
          snapshot: message.state,
          winnerId: message.state.phase === "finished" ? message.state.winnerId : state.winnerId,
        });
        return;
      case "match_finished":
        setState({ winnerId: message.winnerId, roomState: "finished" });
        return;
      case "error":
        setState({ lastError: { code: message.code, message: message.message } });
        return;
    }
  }

  function handleDisconnect(): void {
    clearRoomState();
    if (!reconnect.enabled || state.reconnectAttempt >= reconnect.maxAttempts) {
      setState({ status: "disconnected", reconnectAttempt: 0 });
      return;
    }
    const attempt = state.reconnectAttempt + 1;
    setState({ status: "reconnecting", reconnectAttempt: attempt });
    const delay = Math.min(
      reconnect.baseDelayMs * reconnect.backoffFactor ** (attempt - 1),
      reconnect.maxDelayMs
    );
    pendingReconnect = setTimeout(() => {
      pendingReconnect = null;
      if (closedForever || socket !== null || state.status !== "reconnecting") return;
      if (!openSocket(true)) {
        // The socket could not even be created (e.g. no WebSocket
        // implementation): stop retrying honestly.
        setState({ status: "disconnected", reconnectAttempt: 0 });
      }
    }, delay);
  }

  function sendRaw(payload: string): boolean {
    if (state.status !== "connected" || socket === null) return false;
    try {
      socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect(urlOverride?: string): boolean {
      if (closedForever) return false;
      if (state.status !== "disconnected") return false; // one connection at a time
      if (typeof urlOverride === "string" && urlOverride.length > 0) url = urlOverride;
      if (!url) return false;
      return openSocket(false);
    },
    close(): void {
      if (closedForever) return;
      closedForever = true;
      if (pendingReconnect !== null) {
        clearTimeout(pendingReconnect);
        pendingReconnect = null;
      }
      const ws = socket;
      socket = null; // further events from this socket are ignored
      if (ws) {
        try {
          ws.close();
        } catch {
          // already dead
        }
      }
      setState({ status: "closed" });
    },
    createRoom(): boolean {
      return sendRaw(createRoomMessage());
    },
    joinRoom(roomId: string): boolean {
      if (typeof roomId !== "string" || roomId.length === 0) return false;
      return sendRaw(joinRoomMessage(roomId));
    },
    leaveRoom(): boolean {
      return sendRaw(leaveRoomMessage());
    },
    startMatch(): boolean {
      return sendRaw(startMatchMessage());
    },
    submitCommand(intent: unknown): boolean {
      const payload = commandMessage(intent);
      if (payload === null) return false; // not a sendable client intent
      return sendRaw(payload);
    },
  };
}

/** The browser adapter: native WebSocket behind the WebSocketLike shape. */
function browserSocketFactory(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  return {
    send: (data) => {
      ws.send(data);
    },
    close: () => {
      ws.close();
    },
    onOpen: (cb) => {
      ws.onopen = () => cb();
    },
    onMessage: (cb) => {
      ws.onmessage = (event) => cb(typeof event.data === "string" ? event.data : String(event.data));
    },
    onError: (cb) => {
      ws.onerror = () => cb();
    },
    onClose: (cb) => {
      ws.onclose = () => cb();
    },
  };
}
