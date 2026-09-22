import {
  commandMessage,
  createRoomMessage,
  joinPublicMessage,
  setNameMessage,
  setSkinMessage,
  joinRoomMessage,
  leaveRoomMessage,
  parseServerMessage,
  reconnectMessage,
  returnToLobbyMessage,
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
 * Seat recovery: a seat-holding connection receives an opaque reconnect
 * credential in its personal welcome message. On an unexpected drop the
 * room/seat state is KEPT (the server reserves the seat for a bounded
 * window) and the retry handshake presents the credential instead of
 * starting a fresh session — the same playerId, seat and live match are
 * restored when the server confirms with a welcome. Without a credential
 * (older server, or the connection never held a seat) a drop stays what it
 * always was: a fresh session with the room state honestly cleared. A
 * rejected credential (invalid/expired) clears the room state and returns
 * the client to the lobby surface. Commands are never sent while not
 * connected; no second player is ever created on this side.
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
  /** Matchmaking (Task 17): join any open public game. */
  joinPublicRoom(): boolean;
  leaveRoom(): boolean;
  startMatch(): boolean;
  /**
   * Return to THIS room's waiting lobby after a match (Task 25). Unlike
   * leaveRoom it keeps the seat and the reconnect credential — the
   * player stays in the room, the result screen just gives way to the
   * pre-match lobby so the group can play again.
   */
  returnToLobby(): boolean;
  /**
   * Set THIS client's own display name (cosmetic, lobby-only; the server
   * derives the seat from the session and validates the name — a local
   * pre-check is UX, not authority).
   */
  setName(name: string): boolean;
  /**
   * Set THIS client's own disc skin (cosmetic; the server validates the
   * palette index and broadcasts the roster).
   */
  /**
   * Set this seat's disc skin (a palette index), or `null` to go back
   * to the server-dealt RANDOM skin (excluded colors the seated hold).
   */
  setSkin(skin: number | null): boolean;
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
    roomVisibility: null,
    roster: [],
    hostPlayerId: null,
    autoStartDeadline: null,
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
  /**
   * The current seat's reconnect credential (internal, never part of the
   * public state — it is a secret between this client and the server).
   * Set from a welcome that carries one; cleared on leave, permanent
   * close, or a rejected recovery.
   */
  let reconnectToken: string | null = null;

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
      roomVisibility: null,
      roster: [],
      hostPlayerId: null,
      autoStartDeadline: null,
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
      if (reconnectToken !== null) {
        // Seat recovery: present the credential. The status only becomes
        // "connected" once the server confirms with a welcome — until
        // then the client is honest about not being seated.
        try {
          ws.send(reconnectMessage(reconnectToken));
        } catch {
          // Sending failed — let the close handler own the retry.
        }
        return;
      }
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
        // The welcome is the confirmation for create/join AND for a
        // reconnect handshake: it carries the seat back (same identity on
        // recovery) plus the seat's credential (persistent — the same
        // one may recover future drops too).
        reconnectToken = message.reconnectToken ?? null;
        setState({
          status: "connected",
          reconnectAttempt: 0,
          roomId: message.roomId,
          playerId: message.playerId,
          roomState: message.roomState,
          roomVisibility: message.roomVisibility,
          roster: message.roster,
          hostPlayerId: message.hostPlayerId,
          autoStartDeadline: message.autoStartDeadline,
        });
        return;
      case "room_state":
        setState({
          roomId: message.roomId ?? state.roomId,
          roomState: message.roomState,
          roomVisibility: message.roomVisibility,
          roster: message.roster,
          hostPlayerId: message.hostPlayerId,
          autoStartDeadline: message.autoStartDeadline,
        });
        return;
      case "snapshot":
        // The authoritative state REPLACES whatever we had — no local
        // simulation, no merging, no extrapolation.
        //
        // A winner belongs to a FINISHED match, so a snapshot of a match
        // in progress clears it (Task 25). Before rematches existed this
        // could only ever be the current match's own verdict and holding
        // it was harmless; once a room can play again, keeping the last
        // match's winner through the next one is simply stale state.
        setState({
          snapshot: message.state,
          winnerId:
            message.state.phase === "finished" ? message.state.winnerId : null,
        });
        return;
      case "match_finished":
        setState({ winnerId: message.winnerId, roomState: "finished" });
        return;
      case "error":
        // Expected command races are information, not faults: an intent
        // sent while the player could act can arrive just after the
        // server resolved the round (deadline or the last confirm), and
        // the engine answers wrong-phase. The very next snapshot moves
        // the UI to the new phase anyway, so showing a "Server error"
        // banner would only mislead — skip it. (A rejected reconnect
        // below stays a real error: the seat was lost.)
        // Likewise an already-confirmed echo: a double confirm (click
        // racing the next snapshot, or Space + click) locks in once on
        // the server and answers this on the duplicates. The lock-in is
        // real — the very next snapshot flips the button — so showing a
        // "Server error" banner would only mislead.
        if (
          message.code === "wrong-phase" ||
          message.code === "already-confirmed"
        ) {
          return;
        }
        if (reconnectToken !== null && state.status !== "connected") {
          // A recovery handshake was pending and the server rejected it
          // (invalid or expired credential — indistinguishable by
          // design). Abandon the seat honestly: clear the room state and
          // return to the lobby surface. The socket itself is fine.
          reconnectToken = null;
          clearRoomState();
          setState({
            status: "connected",
            reconnectAttempt: 0,
            lastError: { code: message.code, message: message.message },
          });
          return;
        }
        setState({ lastError: { code: message.code, message: message.message } });
        return;
    }
  }

  function handleDisconnect(): void {
    if (reconnectToken === null) {
      // Nothing to recover: the seat did not survive the connection —
      // clear instead of pretending.
      clearRoomState();
    }
    // With a credential the room/seat state is KEPT: the server reserves
    // the seat for a bounded window and the retry will reclaim it.
    if (!reconnect.enabled || state.reconnectAttempt >= reconnect.maxAttempts) {
      // Recovery is over: this client will not retry again on its own, so
      // the seat is not coming back through THIS credential.
      //
      // The credential must die here. Keeping it meant the next
      // connect() — which the player experiences as starting a fresh
      // game, not resuming one — replayed a dead credential and greeted
      // them with "the reconnect credential is invalid or expired".
      // A credential is only ever replayed by an automatic retry that is
      // still in flight; once we stop retrying, a later connect() is a
      // FRESH session and must send no credential at all.
      //
      // This does not weaken recovery: every retry within the budget
      // still replays it, and the server-side window is untouched.
      if (reconnectToken !== null) {
        reconnectToken = null;
        // The seat state was being held on the credential's behalf; with
        // no way left to reclaim it, showing it would be a lie.
        clearRoomState();
      }
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
      reconnectToken = null; // a permanently closed client never recovers
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
    joinPublicRoom(): boolean {
      return sendRaw(joinPublicMessage());
    },
    joinRoom(roomId: string): boolean {
      if (typeof roomId !== "string" || roomId.length === 0) return false;
      return sendRaw(joinRoomMessage(roomId));
    },
    setSkin(skin: number | null): boolean {
      return sendRaw(setSkinMessage(skin));
    },

    setName(name: string): boolean {
      if (typeof name !== "string" || name.length === 0) return false;
      return sendRaw(setNameMessage(name));
    },
    leaveRoom(): boolean {
      const sent = sendRaw(leaveRoomMessage());
      if (sent) {
        // Leaving on purpose: this connection's credential is useless now
        // (the server revokes it with the seat).
        reconnectToken = null;
        // Protocol v1 never acknowledges a leave — the server sends
        // nothing back to the leaver — so the client must drop the seat
        // state ITSELF. Without this the home screen still believes it
        // holds a seat, and a cosmetic change there (a disc skin, a
        // name) would send set_skin/set_name to a seat that no longer
        // exists and answer "not-in-room".
        clearRoomState();
      }
      return sent;
    },
    startMatch(): boolean {
      return sendRaw(startMatchMessage());
    },
    returnToLobby(): boolean {
      // The seat survives, so (unlike leaveRoom) the reconnect
      // credential is deliberately left intact.
      return sendRaw(returnToLobbyMessage());
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
