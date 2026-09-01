import { randomUUID } from "node:crypto";
import type { CommandRejection, GameCommand, PlayerSpec } from "../game";
import { createGameHost, type GameHost, type SerializedStateListener } from "./gameHost";

/**
 * Room/Match manager — the server-side multiplayer layer above GameHost.
 *
 * A room is the multiplayer wrapper around exactly ONE authoritative match:
 * it tracks a seat roster (playerIds p0..p3 assigned EXCLUSIVELY by the
 * server, in join order), owns exactly one GameHost once the match starts,
 * and derives every command's ownership from the seat, never from the wire.
 *
 * This module contains NO gameplay rules: turn order, elimination, phases
 * and winning all stay in the engine; the host wraps the engine; the room
 * manager wraps the host. What it does own is room policy:
 *
 *   - seats: 2..4 players, lowest free seat assigned, no duplicates;
 *   - lifecycle: waiting → playing → finished (see RoomState);
 *   - identity: commands are re-stamped with the seat's playerId — any
 *     playerId (or unknown field) a client sends is dropped here;
 *   - authorization: the match-level `reset` command is privileged and is
 *     rejected on the player path (see submitCommand); only the server
 *     itself may reset a match (resetMatch).
 *
 * Sessions are referenced by their opaque token (see session.ts); this
 * module never looks at anything else about a connection. No networking,
 * no persistence — the future WebSocket transport calls into this manager
 * through the game server facade (gameServer.ts).
 */

/** Room lifecycle. Minimal by design — no matchmaking, no timers. */
export type RoomState =
  /** Roster forming; seats may still join/leave freely. */
  | "waiting"
  /** Match running (or paused between turns); the roster is frozen. */
  | "playing"
  /** Match over (winner or no survivor). Rematch = privileged reset. */
  | "finished";

/** A room needs at least this many seated players to start a match. */
export const MIN_PLAYERS = 2;
/** Hard seat capacity — the playerIds p0..p3. */
export const MAX_PLAYERS = 4;

/** One roster seat as seen from outside. */
export interface RoomSeatInfo {
  /** Server-assigned seat id ("p0".."p3"). */
  readonly playerId: string;
  /** false once that player left after the match started (roster frozen). */
  readonly connected: boolean;
}

/** Immutable room snapshot (for transports, tests, observability). */
export interface RoomInfo {
  readonly id: string;
  readonly state: RoomState;
  /** Occupied seats in seat order (vacated match seats stay listed). */
  readonly seats: readonly RoomSeatInfo[];
  /**
   * Seat id of the room host (the creating session), or null once the
   * creator is no longer seated. Used by transports to authorize
   * match-level actions (e.g. only the host may start the match).
   */
  readonly hostPlayerId: string | null;
}

export type SeatResult =
  | { ok: true; room: RoomInfo; playerId: string }
  | {
      ok: false;
      reason:
        | "unknown-session" // malformed/absent session token
        | "already-in-room" // seated sessions must leave first
        | "unknown-room"
        | "room-full" // > MAX_PLAYERS
        | "room-playing"; // roster frozen (playing or finished)
    };

export type LeaveResult =
  | { ok: true; room: RoomInfo | null } // null: the room was removed
  | { ok: false; reason: "unknown-session" | "not-in-room" };

export type StartResult =
  | { ok: true; room: RoomInfo }
  | {
      ok: false;
      reason: "unknown-room" | "not-enough-players" | "already-playing";
    };

export type ResetResult =
  | { ok: true }
  | { ok: false; reason: "unknown-room" | "no-match" | CommandRejection };

/**
 * Why a command was rejected at the server level. Superset of the engine's
 * CommandRejection: engine reasons pass through unchanged, plus the
 * room/session/authorization rejections owned by this layer.
 */
export type ServerCommandRejection =
  | CommandRejection
  | "unknown-session" // no such live session
  | "not-in-room" // session is not seated anywhere
  | "no-match" // seated, but the match has not started
  | "unauthorized"; // privileged action attempted via the player path

export type ServerCommandResult =
  | { ok: true }
  | { ok: false; reason: ServerCommandRejection };

interface RoomEntry {
  id: string;
  state: RoomState;
  /** seat index (0..3) → occupying session token; null = free seat. */
  seats: Array<string | null>;
  /** Seats vacated after the match started — the roster is frozen. */
  vacated: Set<number>;
  /** The creating session's token — the room host (see RoomInfo.hostPlayerId). */
  hostToken: string;
  host: GameHost | null;
  detachHost: (() => void) | null;
  /** State listeners (the transport broadcast hook), per session token. */
  listeners: Array<{ token: string; cb: SerializedStateListener }>;
}

export interface RoomManager {
  /** Create a room; the creating session takes seat p0. */
  createRoom(token: string): SeatResult;
  /** Join a waiting room; the session takes the lowest free seat. */
  joinRoom(token: string, roomId: string): SeatResult;
  /** Leave the session's room (frees the seat, or vacates it mid-match). */
  leaveRoom(token: string): LeaveResult;
  /** Room snapshot by id, or null. */
  getRoom(roomId: string): RoomInfo | null;
  /** Resolve a session token to its room and assigned playerId. */
  resolveSeat(token: string): { room: RoomInfo; playerId: string } | null;
  /** Start the match with the current stable roster (creates the GameHost). */
  startMatch(roomId: string): StartResult;
  /**
   * Privileged, server-controlled reset of a running match. This is the
   * ONLY path through which a match may be reset — players cannot.
   */
  resetMatch(roomId: string): ResetResult;
  /** Destroy rooms with no connected players; returns how many were removed. */
  removeEmptyRooms(): number;
  /** Subscribe a seated session to its room's match state (broadcast hook). */
  onRoomState(token: string, listener: SerializedStateListener): () => void;
  /** Number of live rooms (observability/tests). */
  roomCount(): number;
  /** Tear down every room and GameHost (server shutdown/tests). */
  destroy(): void;
  /**
   * Validate and apply a command on behalf of a seated session. The
   * playerId is derived from the seat; the wire command's own playerId
   * (and every unknown field) is dropped at this boundary.
   */
  submitCommand(token: string, command: unknown): ServerCommandResult;
}

export function createRoomManager(): RoomManager {
  const rooms = new Map<string, RoomEntry>();

  // ── internals ─────────────────────────────────────────────────────────

  function validKey(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  function findSeat(token: string): { room: RoomEntry; seat: number } | null {
    for (const room of rooms.values()) {
      const seat = room.seats.indexOf(token);
      if (seat !== -1) return { room, seat };
    }
    return null;
  }

  function lowestFreeSeat(room: RoomEntry): number {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (room.seats[i] === null && !room.vacated.has(i)) return i;
    }
    return -1;
  }

  function connectedCount(room: RoomEntry): number {
    let n = 0;
    for (const seat of room.seats) if (seat !== null) n += 1;
    return n;
  }

  function infoOf(room: RoomEntry): RoomInfo {
    const seats: RoomSeatInfo[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (room.seats[i] !== null) {
        seats.push({ playerId: `p${i}`, connected: true });
      } else if (room.vacated.has(i)) {
        seats.push({ playerId: `p${i}`, connected: false });
      }
    }
    // The host is whoever the creating session is seated as right now;
    // null once the creator has left (the room then has no host until it
    // is removed — transports document their policy on top of this).
    const hostSeat = room.seats.indexOf(room.hostToken);
    return {
      id: room.id,
      state: room.state,
      seats,
      hostPlayerId: hostSeat === -1 ? null : `p${hostSeat}`,
    };
  }

  function destroyRoom(room: RoomEntry): void {
    if (room.detachHost) room.detachHost();
    room.detachHost = null;
    if (room.host) {
      room.host.destroy();
      room.host = null;
    }
    room.listeners = [];
    rooms.delete(room.id);
  }

  /** Cheap phase peek into a serialized state (lifecycle tracking only). */
  function phaseOf(serialized: string): string | null {
    try {
      const parsed = JSON.parse(serialized) as { phase?: unknown };
      return typeof parsed.phase === "string" ? parsed.phase : null;
    } catch {
      return null;
    }
  }

  // ── room operations ───────────────────────────────────────────────────

  function createRoom(token: string): SeatResult {
    if (!validKey(token)) return { ok: false, reason: "unknown-session" };
    if (findSeat(token)) return { ok: false, reason: "already-in-room" };
    const room: RoomEntry = {
      id: randomUUID(),
      state: "waiting",
      seats: [null, null, null, null],
      vacated: new Set(),
      hostToken: token, // the creator is the room host
      host: null,
      detachHost: null,
      listeners: [],
    };
    rooms.set(room.id, room);
    room.seats[0] = token;
    return { ok: true, room: infoOf(room), playerId: "p0" };
  }

  function joinRoom(token: string, roomId: string): SeatResult {
    if (!validKey(token)) return { ok: false, reason: "unknown-session" };
    if (!validKey(roomId)) return { ok: false, reason: "unknown-room" };
    const room = rooms.get(roomId);
    if (!room) return { ok: false, reason: "unknown-room" };
    if (findSeat(token)) return { ok: false, reason: "already-in-room" };
    if (room.state !== "waiting") return { ok: false, reason: "room-playing" };
    const seat = lowestFreeSeat(room);
    if (seat === -1) return { ok: false, reason: "room-full" };
    room.seats[seat] = token;
    return { ok: true, room: infoOf(room), playerId: `p${seat}` };
  }

  function leaveRoom(token: string): LeaveResult {
    if (!validKey(token)) return { ok: false, reason: "unknown-session" };
    const seated = findSeat(token);
    if (!seated) return { ok: false, reason: "not-in-room" };
    const { room, seat } = seated;

    room.seats[seat] = null;
    room.listeners = room.listeners.filter((l) => l.token !== token);

    if (connectedCount(room) === 0) {
      destroyRoom(room); // empty rooms do not linger
      return { ok: true, room: null };
    }
    if (room.state !== "waiting") {
      // The roster is frozen once the match started: the pawn stays in the
      // match, the seat is simply vacated (reconnection is future work).
      room.vacated.add(seat);
    }
    return { ok: true, room: infoOf(room) };
  }

  function getRoom(roomId: string): RoomInfo | null {
    if (!validKey(roomId)) return null;
    const room = rooms.get(roomId);
    return room ? infoOf(room) : null;
  }

  function resolveSeat(token: string): { room: RoomInfo; playerId: string } | null {
    if (!validKey(token)) return null;
    const seated = findSeat(token);
    if (!seated) return null;
    return { room: infoOf(seated.room), playerId: `p${seated.seat}` };
  }

  function startMatch(roomId: string): StartResult {
    if (!validKey(roomId)) return { ok: false, reason: "unknown-room" };
    const room = rooms.get(roomId);
    if (!room) return { ok: false, reason: "unknown-room" };
    if (room.state !== "waiting") return { ok: false, reason: "already-playing" };

    const occupied: number[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (room.seats[i] !== null) occupied.push(i);
    }
    if (occupied.length < MIN_PLAYERS) {
      return { ok: false, reason: "not-enough-players" };
    }

    // The stable roster: exactly the occupied seats, in seat order. The
    // engine receives server-built PlayerSpecs — clients contributed
    // nothing but their presence.
    const roster: PlayerSpec[] = occupied.map((i) => ({
      id: `p${i}`,
      name: `Player ${i + 1}`,
    }));

    const host = createGameHost({ players: roster });
    room.host = host;
    room.state = "playing";
    // One subscription drives both the room lifecycle (finished detection)
    // and the broadcast hook for every seated session.
    room.detachHost = host.onStateChange((serialized) => {
      room.state = phaseOf(serialized) === "finished" ? "finished" : "playing";
      for (const listener of [...room.listeners]) listener.cb(serialized);
    });
    host.start(); // the fixed 60 Hz loop — this is a real match now
    return { ok: true, room: infoOf(room) };
  }

  function resetMatch(roomId: string): ResetResult {
    if (!validKey(roomId)) return { ok: false, reason: "unknown-room" };
    const room = rooms.get(roomId);
    if (!room) return { ok: false, reason: "unknown-room" };
    if (!room.host) return { ok: false, reason: "no-match" };
    // The server itself submits the engine's match-level reset command.
    // Room state flips back to "playing" via the host state subscription.
    return room.host.submitCommand({ type: "reset" });
  }

  function removeEmptyRooms(): number {
    let removed = 0;
    for (const room of [...rooms.values()]) {
      if (connectedCount(room) === 0) {
        destroyRoom(room);
        removed += 1;
      }
    }
    return removed;
  }

  function onRoomState(token: string, listener: SerializedStateListener): () => void {
    const seated = validKey(token) ? findSeat(token) : null;
    if (!seated) return () => {}; // nothing to observe (yet)
    const { room } = seated;
    const entry = { token, cb: listener };
    room.listeners.push(entry);
    // Mirrors GameHost.onStateChange: a listener attaching to a running
    // match immediately receives the current snapshot. While the room is
    // still waiting there is no match state yet — the first push happens
    // when the match starts.
    if (room.host) listener(room.host.serializedState());
    return () => {
      room.listeners = room.listeners.filter((l) => l !== entry);
    };
  }

  function roomCount(): number {
    return rooms.size;
  }

  function destroy(): void {
    for (const room of [...rooms.values()]) destroyRoom(room);
  }

  // ── the command path: identity from the seat, never from the wire ─────

  function submitCommand(token: string, command: unknown): ServerCommandResult {
    if (!validKey(token)) return { ok: false, reason: "unknown-session" };
    const seated = findSeat(token);
    if (!seated) return { ok: false, reason: "not-in-room" };
    const { room } = seated;
    if (!room.host) return { ok: false, reason: "no-match" };
    const playerId = `p${seated.seat}`;

    // Rebuild the command from known fields ONLY, stamped with the seat's
    // playerId. Whatever the client sent as playerId — or in any other
    // field — is dropped here. Total function: hostile getters, proxies
    // and junk never throw past this boundary.
    let rebuilt: GameCommand;
    try {
      if (typeof command !== "object" || command === null) {
        return { ok: false, reason: "invalid-command" };
      }
      const wire = command as Record<string, unknown>;
      switch (wire.type) {
        case "aim":
          rebuilt = {
            type: "aim",
            playerId,
            // Wire fields flow through unvalidated by design: the engine's
            // total validator rejects non-finite numbers right after this.
            x: wire.x as number,
            y: wire.y as number,
          };
          break;
        case "setPower":
          rebuilt = { type: "setPower", playerId, power: wire.power as number };
          break;
        case "confirmLaunch":
          rebuilt = { type: "confirmLaunch", playerId };
          break;
        case "reset":
          // Match-level action: privileged. A player command must never
          // reset other players' match — the server calls resetMatch()
          // (behind whatever authorization the transport adds later).
          return { ok: false, reason: "unauthorized" };
        default:
          return { ok: false, reason: "invalid-command" };
      }
    } catch {
      return { ok: false, reason: "invalid-command" };
    }

    // Structure, ownership (turn/elimination) and phase rules all stay in
    // the engine — the host validates and applies.
    return room.host.submitCommand(rebuilt);
  }

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    getRoom,
    resolveSeat,
    startMatch,
    resetMatch,
    removeEmptyRooms,
    onRoomState,
    roomCount,
    destroy,
    submitCommand,
  };
}
