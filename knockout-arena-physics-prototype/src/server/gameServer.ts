import { createSession, isSession, type Session } from "./session";
import {
  createRoomManager,
  DEFAULT_RESERVATION_MS,
  type LeaveResult,
  type NameResult,
  type ResetResult,
  type ResolveRoundResult,
  type RoomInfo,
  type RoomManager,
  type SeatResult,
  type ServerCommandResult,
  type StartResult,
} from "./roomManager";
import { createReconnectRegistry } from "./reconnect";
import type { SerializedStateListener } from "./gameHost";
import {
  deserializeGameState,
  projectSnapshot,
  type GameStateSnapshot,
} from "../game";

/**
 * The game server facade — the transport-neutral API the WebSocket layer
 * attaches to. It owns the session registry (connections) and the
 * reconnection credentials, and delegates room/match concerns to the
 * RoomManager.
 *
 * The authoritative identity chain, enforced here:
 *
 *   connection/session  →  server-assigned playerId  →  room membership
 *                       →  GameHost.submitCommand(playerId, command)
 *
 * Sessions are issued by connect() and are the only way in. Every method
 * accepts the session as `unknown` on purpose: input from the wire is
 * untrusted until the session resolves against the registry. The player
 * NEVER chooses a playerId — the seat assignment decides, and commands
 * are stamped with it (see roomManager.submitCommand).
 *
 * Reconnection (the session domain, this module):
 *
 *   - taking a seat (createRoom/joinRoom) issues an opaque reconnect
 *     credential for that seat, returned ONLY to that player;
 *   - reserve() opens that seat's reconnect window after an unexpected
 *     connection drop (the seat stays reserved, not stealable);
 *   - reconnect(credential) reclaims the seat on a new connection — same
 *     session identity, same playerId, same match — or fails uniformly
 *     ("invalid-reconnect") for unknown, stale and expired credentials;
 *   - credentials are revoked the moment their seat is gone (leave,
 *     force-disconnect, reservation expiry, server teardown).
 *
 * Transport wiring:
 *
 *   on connect:    session = server.connect()
 *   on message:    server.createRoom(session) | server.joinRoom(session, id)
 *                  | server.submitCommand(session, command)
 *   on state:      server.onRoomState(session, broadcast)   // push hook
 *   on drop:       server.reserve(session)                  // reconnect window
 *                  (fall back to server.disconnect if not seated)
 *   on close:      server.disconnect(session)               // clean leave
 */

/** Options for createGameServer. */
export interface GameServerOptions {
  /**
   * How long a disconnected player's seat stays reserved before the
   * normal leave rules take over. Default 30 000 ms. Applies to every
   * reservation opened via reserve().
   */
  reconnectReservationMs?: number;
  /**
   * The round decision deadline for every match (passed through the room
   * manager to each GameHost): after this many milliseconds in the
   * "aiming" phase the server resolves the round — confirmed players
   * move, unconfirmed do not. Default 10 000 ms (see createGameHost).
   */
  roundDecisionTimeoutMs?: number;
}

/** A seat result that carries the seat's reconnect credential. */
export type SeatedResult =
  | {
      ok: true;
      room: RoomInfo;
      playerId: string;
      /** Opaque credential to reclaim this seat after a drop. */
      reconnectToken: string;
    }
  | Extract<SeatResult, { ok: false }>;

/**
 * The outcome of presenting a reconnect credential. The failure carries
 * NO detail on purpose: unknown, malformed, stale and expired credentials
 * are indistinguishable ("invalid-reconnect") — no existence leak.
 */
export type ReconnectResult =
  | {
      ok: true;
      session: Session;
      room: RoomInfo;
      playerId: string;
      /** The credential, valid again (persistent until revoked). */
      reconnectToken: string;
    }
  | { ok: false; reason: "invalid-reconnect" };

export interface GameServer {
  /** Issue a new session (a connection identity). */
  connect(): Session;
  /**
   * Tear down a session: leaves its room cleanly (freeing or vacating the
   * seat, removing the room if it empties), revokes its reconnect
   * credential and invalidates the token. Returns true if a live session
   * was disconnected. This is the FORCE path — use reserve() for drops
   * that should be recoverable.
   */
  disconnect(session: unknown): boolean;
  /**
   * Open the session's reconnect window after an unexpected connection
   * drop: the seat stays occupied and reserved (reported disconnected,
   * invisible to joiners) until the session reconnects or the window
   * expires. Returns not-in-room if the session has no seat — the caller
   * should then disconnect() instead.
   */
  reserve(session: unknown): { ok: true } | { ok: false; reason: "unknown-session" | "not-in-room" };
  /**
   * Reclaim a seat with a reconnect credential: restores the session's
   * identity (same session, same playerId, same match state — nothing is
   * restarted) and returns the seat info plus the credential for the new
   * connection. Fails uniformly for any credential this server did not
   * issue, or that has since been revoked (seat left/expired/destroyed).
   */
  reconnect(rawToken: unknown): ReconnectResult;
  /** Create a room; the session takes seat p0 (issues a credential). */
  createRoom(session: unknown): SeatedResult;
  /** Join a waiting room by id; the session takes the lowest free seat (issues a credential). */
  joinRoom(session: unknown, roomId: unknown): SeatedResult;
  /** Leave the session's current room (revokes its credential). */
  leaveRoom(session: unknown): LeaveResult;
  /**
   * Set the session's OWN display name (cosmetic; see roomManager).
   * The seat is derived from the session — a caller can never name
   * another player, and the server validates the name for real.
   */
  setName(session: unknown, name: unknown): NameResult;
  /** Room snapshot by id (null if unknown/malformed). */
  getRoom(roomId: unknown): RoomInfo | null;
  /** Resolve the identity chain: session → { room, assigned playerId }. */
  getSeat(session: unknown): { room: RoomInfo; playerId: string } | null;
  /** Start the room's match with its stable roster (creates the GameHost). */
  startMatch(roomId: unknown): StartResult;
  /**
   * Privileged, server-controlled match reset. Not reachable through the
   * player command path — the transport calls this after its own
   * authorization policy (host-only / rematch vote) is decided.
   */
  resetMatch(roomId: unknown): ResetResult;
  /**
   * Privileged, server-controlled round resolution (decision deadline):
   * confirmed players move together, unconfirmed players stay. Not
   * reachable through the player command path.
   */
  resolveRound(roomId: unknown): ResolveRoundResult;
  /**
   * Validate and apply a command for the session. The playerId comes from
   * the session's seat; any playerId in the command payload is ignored.
   */
  submitCommand(session: unknown, command: unknown): ServerCommandResult;
  /** Subscribe a seated session to its room's serialized match state. */
  onRoomState(session: unknown, listener: SerializedStateListener): () => void;
  /**
   * Like onRoomState, but each push is projected for THE SESSION'S OWN pawn
   * using the engine's viewer-local projection (projectSnapshot) — the
   * natural read model for a per-client transport. The authoritative state
   * itself is never altered or exposed per-viewer.
   */
  onRoomView(
    session: unknown,
    listener: (view: GameStateSnapshot) => void
  ): () => void;
  /** Destroy rooms with no connected players; returns the count removed. */
  removeEmptyRooms(): number;
  /** Number of live rooms. */
  roomCount(): number;
  /** Number of live sessions (reserved seats keep their session alive). */
  sessionCount(): number;
  /** Tear down everything (all rooms, hosts, sessions and credentials). */
  destroy(): void;
}

export function createGameServer(options?: GameServerOptions): GameServer {
  const manager: RoomManager = createRoomManager({
    roundDecisionTimeoutMs: options?.roundDecisionTimeoutMs,
  });
  const reservationMs = options?.reconnectReservationMs ?? DEFAULT_RESERVATION_MS;
  /** Live sessions by their opaque token (the registry's canonical objects). */
  const sessions = new Map<string, Session>();
  /** Reconnect credentials: seat recovery, server-issued only. */
  const credentials = createReconnectRegistry();

  /** Resolve untrusted input to a live session, or null. */
  function resolve(session: unknown): Session | null {
    if (!isSession(session)) return null;
    return sessions.get(session.token) ?? null;
  }

  function asRoomId(roomId: unknown): string | null {
    return typeof roomId === "string" && roomId.length > 0 ? roomId : null;
  }

  function connect(): Session {
    const session = createSession();
    sessions.set(session.token, session);
    return session;
  }

  function disconnect(session: unknown): boolean {
    const s = resolve(session);
    if (!s) return false;
    manager.leaveRoom(s.token); // clean leave; may remove an emptied room
    credentials.revokeSession(s.token); // the credential dies with the seat
    sessions.delete(s.token);
    return true;
  }

  function reserve(
    session: unknown
  ): { ok: true } | { ok: false; reason: "unknown-session" | "not-in-room" } {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    const reserved = manager.reserveSeat(s.token, {
      reservationMs,
      onExpire: () => {
        // The window closed: the seat is released (normal leave rules,
        // applied by the room manager before this callback) — the session
        // identity and its credential must not survive it.
        credentials.revokeSession(s.token);
        sessions.delete(s.token);
      },
    });
    if (!reserved.ok) return reserved;
    return { ok: true };
  }

  function reconnect(rawToken: unknown): ReconnectResult {
    const cred = credentials.resolve(rawToken);
    if (!cred) return { ok: false, reason: "invalid-reconnect" };
    const session = sessions.get(cred.sessionToken);
    if (!session) {
      // Session already invalidated (force path / teardown) — the
      // credential should be gone too; revoke defensively.
      credentials.revokeSession(cred.sessionToken);
      return { ok: false, reason: "invalid-reconnect" };
    }
    const restored = manager.restoreSeat(cred.sessionToken);
    if (
      !restored.ok ||
      restored.room.id !== cred.roomId ||
      restored.playerId !== cred.playerId
    ) {
      // The credential no longer matches a live seat of that session —
      // stale credential; kill it and fail indistinguishably.
      credentials.revokeSession(cred.sessionToken);
      return { ok: false, reason: "invalid-reconnect" };
    }
    return {
      ok: true,
      session,
      room: restored.room,
      playerId: restored.playerId,
      reconnectToken: rawToken as string,
    };
  }

  /** Stamp a successful seat result with the seat's reconnect credential. */
  function withCredential(token: string, result: SeatResult): SeatedResult {
    if (!result.ok) return result;
    const reconnectToken = credentials.issue(
      token,
      result.room.id,
      result.playerId
    );
    return {
      ok: true,
      room: result.room,
      playerId: result.playerId,
      reconnectToken,
    };
  }

  function createRoom(session: unknown): SeatedResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    return withCredential(s.token, manager.createRoom(s.token));
  }

  function joinRoom(session: unknown, roomId: unknown): SeatedResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    const id = asRoomId(roomId);
    if (!id) return { ok: false, reason: "unknown-room" };
    return withCredential(s.token, manager.joinRoom(s.token, id));
  }

  function setName(session: unknown, name: unknown): NameResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    if (typeof name !== "string") return { ok: false, reason: "invalid-name" };
    return manager.setName(s.token, name);
  }

  function leaveRoom(session: unknown): LeaveResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    const result = manager.leaveRoom(s.token);
    if (result.ok) {
      // The seat is gone — its credential must stop working immediately.
      credentials.revokeSession(s.token);
    }
    return result;
  }

  function getRoom(roomId: unknown): RoomInfo | null {
    const id = asRoomId(roomId);
    return id ? manager.getRoom(id) : null;
  }

  function getSeat(session: unknown): { room: RoomInfo; playerId: string } | null {
    const s = resolve(session);
    return s ? manager.resolveSeat(s.token) : null;
  }

  function startMatch(roomId: unknown): StartResult {
    const id = asRoomId(roomId);
    if (!id) return { ok: false, reason: "unknown-room" };
    return manager.startMatch(id);
  }

  function resetMatch(roomId: unknown): ResetResult {
    const id = asRoomId(roomId);
    if (!id) return { ok: false, reason: "unknown-room" };
    return manager.resetMatch(id);
  }

  function resolveRound(roomId: unknown): ResolveRoundResult {
    const id = asRoomId(roomId);
    if (!id) return { ok: false, reason: "unknown-room" };
    return manager.resolveRound(id);
  }

  function submitCommand(session: unknown, command: unknown): ServerCommandResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    return manager.submitCommand(s.token, command);
  }

  function onRoomState(session: unknown, listener: SerializedStateListener): () => void {
    const s = resolve(session);
    if (!s || typeof listener !== "function") return () => {};
    return manager.onRoomState(s.token, listener);
  }

  function onRoomView(
    session: unknown,
    listener: (view: GameStateSnapshot) => void
  ): () => void {
    const s = resolve(session);
    if (!s || typeof listener !== "function") return () => {};
    // Capture the seat at subscription time: subscriptions are per
    // room-membership (leaving removes them), so the seat stays valid for
    // the subscription's lifetime and re-subscribing after rejoining picks
    // up the new seat.
    const seat = manager.resolveSeat(s.token);
    if (!seat) return () => {};
    return manager.onRoomState(s.token, (serialized) => {
      // Reuses the engine's own projection — no view logic lives here.
      // The round decision deadline is stamped from the room's host AT
      // PUSH TIME: the host arms a fresh token on every entry into
      // "aiming" and cancels it on every exit BEFORE notifying listeners,
      // so this presentation metadata always matches the pushed state —
      // fresh per aiming round, null the moment the round resolves, the
      // match finishes or the room has no match. Read-only for clients:
      // they may render a countdown from it, never act on it.
      listener({
        ...projectSnapshot(deserializeGameState(serialized), seat.playerId),
        roundDeadline: manager.roundDeadline(seat.room.id),
      });
    });
  }

  function removeEmptyRooms(): number {
    return manager.removeEmptyRooms();
  }

  function roomCount(): number {
    return manager.roomCount();
  }

  function sessionCount(): number {
    return sessions.size;
  }

  function destroy(): void {
    manager.destroy();
    sessions.clear();
    credentials.clear();
  }

  return {
    connect,
    disconnect,
    reserve,
    reconnect,
    createRoom,
    joinRoom,
    leaveRoom,
    setName,
    getRoom,
    getSeat,
    startMatch,
    resetMatch,
    resolveRound,
    submitCommand,
    onRoomState,
    onRoomView,
    removeEmptyRooms,
    roomCount,
    sessionCount,
    destroy,
  };
}
