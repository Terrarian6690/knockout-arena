import { createSession, isSession, type Session } from "./session";
import {
  createRoomManager,
  type LeaveResult,
  type ResetResult,
  type RoomInfo,
  type RoomManager,
  type SeatResult,
  type ServerCommandResult,
  type StartResult,
} from "./roomManager";
import type { SerializedStateListener } from "./gameHost";
import {
  deserializeGameState,
  projectSnapshot,
  type GameStateSnapshot,
} from "../game";

/**
 * The game server facade — the transport-neutral API a future WebSocket
 * layer will attach to. It owns the session registry (connections) and
 * delegates room/match concerns to the RoomManager.
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
 * Intended transport wiring (no networking implemented yet):
 *
 *   on connect:    session = server.connect()
 *   on message:    server.createRoom(session) | server.joinRoom(session, id)
 *                  | server.submitCommand(session, command)
 *   on state:      server.onRoomState(session, broadcast)   // push hook
 *   on disconnect: server.disconnect(session)               // clean leave
 */
export interface GameServer {
  /** Issue a new session (a connection identity). */
  connect(): Session;
  /**
   * Tear down a session: leaves its room cleanly (freeing or vacating the
   * seat, removing the room if it empties) and invalidates the token.
   * Returns true if a live session was disconnected.
   */
  disconnect(session: unknown): boolean;
  /** Create a room; the session takes seat p0. */
  createRoom(session: unknown): SeatResult;
  /** Join a waiting room by id; the session takes the lowest free seat. */
  joinRoom(session: unknown, roomId: unknown): SeatResult;
  /** Leave the session's current room. */
  leaveRoom(session: unknown): LeaveResult;
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
  /** Number of live sessions. */
  sessionCount(): number;
  /** Tear down everything (all rooms, hosts and sessions). */
  destroy(): void;
}

export function createGameServer(): GameServer {
  const manager: RoomManager = createRoomManager();
  const liveTokens = new Set<string>();

  /** Resolve untrusted input to a live session, or null. */
  function resolve(session: unknown): Session | null {
    if (!isSession(session)) return null;
    return liveTokens.has(session.token) ? session : null;
  }

  function asRoomId(roomId: unknown): string | null {
    return typeof roomId === "string" && roomId.length > 0 ? roomId : null;
  }

  function connect(): Session {
    const session = createSession();
    liveTokens.add(session.token);
    return session;
  }

  function disconnect(session: unknown): boolean {
    const s = resolve(session);
    if (!s) return false;
    manager.leaveRoom(s.token); // clean leave; may remove an emptied room
    liveTokens.delete(s.token);
    return true;
  }

  function createRoom(session: unknown): SeatResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    return manager.createRoom(s.token);
  }

  function joinRoom(session: unknown, roomId: unknown): SeatResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    const id = asRoomId(roomId);
    if (!id) return { ok: false, reason: "unknown-room" };
    return manager.joinRoom(s.token, id);
  }

  function leaveRoom(session: unknown): LeaveResult {
    const s = resolve(session);
    if (!s) return { ok: false, reason: "unknown-session" };
    return manager.leaveRoom(s.token);
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
      listener(projectSnapshot(deserializeGameState(serialized), seat.playerId));
    });
  }

  function removeEmptyRooms(): number {
    return manager.removeEmptyRooms();
  }

  function roomCount(): number {
    return manager.roomCount();
  }

  function sessionCount(): number {
    return liveTokens.size;
  }

  function destroy(): void {
    manager.destroy();
    liveTokens.clear();
  }

  return {
    connect,
    disconnect,
    createRoom,
    joinRoom,
    leaveRoom,
    getRoom,
    getSeat,
    startMatch,
    resetMatch,
    submitCommand,
    onRoomState,
    onRoomView,
    removeEmptyRooms,
    roomCount,
    sessionCount,
    destroy,
  };
}
