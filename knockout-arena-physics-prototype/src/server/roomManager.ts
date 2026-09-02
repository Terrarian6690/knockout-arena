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
 *   - authorization: the match-level `reset` and `resolveRound` commands
 *     are privileged and are rejected on the player path (see
 *     submitCommand); only the server itself may reset a match
 *     (resetMatch) or resolve a round at its deadline (resolveRound —
 *     called manually OR automatically by the host's round decision
 *     deadline, which enforces the same 10 s aiming-round maximum);
 *   - reconnection: a disconnected session's seat is temporarily RESERVED
 *     (occupied, reported disconnected, invisible to joiners) until it
 *     reclaims it (restoreSeat) or the reservation expires — expiry then
 *     applies the normal leave rules (seat freed / vacated mid-match).
 *
 * Sessions are referenced by their opaque token (see session.ts); this
 * module never looks at anything else about a connection. No networking,
 * no persistence — the transport calls into this manager through the game
 * server facade (gameServer.ts).
 */

/** Room lifecycle. Minimal by design — no matchmaking, no turn timers. */
export type RoomState =
  /** Roster forming; seats may still join/leave freely. */
  | "waiting"
  /** Match running (or paused between rounds); the roster is frozen. */
  | "playing"
  /** Match over (winner or no survivor). Rematch = privileged reset. */
  | "finished";

/** A room needs at least this many seated players to start a match. */
export const MIN_PLAYERS = 2;
/** Hard seat capacity — the playerIds p0..p3. */
export const MAX_PLAYERS = 4;
/**
 * How long a disconnected player's seat stays reserved before the normal
 * leave rules take over (seat freed/vacated, credential revoked). The game
 * server owns the configured value it passes to reserveSeat().
 */
export const DEFAULT_RESERVATION_MS = 30_000;

/** Options for createRoomManager. */
export interface RoomManagerOptions {
  /**
   * The round decision deadline applied to every match this manager
   * starts: after this many milliseconds in the "aiming" phase the server
   * itself resolves the round (confirmed players move, unconfirmed do
   * not). See createGameHost. Default: DEFAULT_ROUND_DECISION_TIMEOUT_MS
   * (10 000 ms).
   */
  roundDecisionTimeoutMs?: number;
}

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

/**
 * Options for seat reservation (a disconnected player's reconnect window).
 */
export interface ReserveOptions {
  /** How long the seat stays reserved before it is released. Default 30s. */
  reservationMs?: number;
  /**
   * Called once the reservation expires, after the seat has been released
   * with the normal leave semantics. The game server uses this to revoke
   * the session's reconnect credential (an expired one must stop working).
   */
  onExpire?: () => void;
}

export type ReserveResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unknown-session" // malformed/absent session token
        | "not-in-room"; // nothing to reserve
    };

export type RestoreResult =
  | { ok: true; room: RoomInfo; playerId: string }
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

/** Result of the privileged resolveRound (decision deadline) operation. */
export type ResolveRoundResult = ResetResult;

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
  /**
   * Seat index → live reservation for a disconnected-but-still-seated
   * session (its reconnect window). The seat stays OCCUPIED — invisible
   * to joiners and counted by removeEmptyRooms — but reports
   * connected:false until the session reclaims it or the timer expires.
   */
  reserved: Map<number, { timer: ReturnType<typeof setTimeout>; onExpire?: () => void }>;
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
  /**
   * Open a reconnect window for a seated session whose connection dropped:
   * the seat stays reserved (not stealable, not freed) until it expires.
   * Re-reserving an already reserved seat restarts its timer.
   */
  reserveSeat(token: string, options?: ReserveOptions): ReserveResult;
  /**
   * Reclaim a seat for reconnect: clears the reservation (if any) and
   * reports the seat. Idempotent — a seated session that was never
   * reserved (its connection is still live) also restores fine.
   */
  restoreSeat(token: string): RestoreResult;
  /** Room snapshot by id, or null. */
  getRoom(roomId: string): RoomInfo | null;
  /** Resolve a session token to its room and assigned playerId. */
  resolveSeat(token: string): { room: RoomInfo; playerId: string } | null;
  /**
   * Start the match with the current stable roster (creates the GameHost).
   * Reserved (disconnected) seats count — the roster is occupied seats;
   * the host may start while waiting for a player to reconnect.
   */
  startMatch(roomId: string): StartResult;
  /**
   * Privileged, server-controlled reset of a running match. This is the
   * ONLY path through which a match may be reset — players cannot.
   */
  resetMatch(roomId: string): ResetResult;
  /**
   * Privileged, server-controlled round resolution (the decision
   * deadline): confirmed players move together, unconfirmed players stay.
   * The ONLY path through which a round may be force-resolved — players
   * cannot (submitCommand rejects it as unauthorized).
   */
  resolveRound(roomId: string): ResolveRoundResult;
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

export function createRoomManager(options?: RoomManagerOptions): RoomManager {
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
        // Reserved seats stay occupied but report disconnected — the
        // player's connection dropped and their reconnect window is open.
        seats.push({ playerId: `p${i}`, connected: !room.reserved.has(i) });
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
    for (const { timer } of room.reserved.values()) clearTimeout(timer);
    room.reserved.clear();
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
      reserved: new Map(),
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
    cancelReservation(seated.room, seated.seat); // an explicit leave is not a disconnect
    const room = detachSeat(seated.room, seated.seat);
    return { ok: true, room };
  }

  /** Cancel a seat's reservation (timer + callback) without releasing it. */
  function cancelReservation(room: RoomEntry, seat: number): void {
    const reservation = room.reserved.get(seat);
    if (reservation === undefined) return;
    clearTimeout(reservation.timer);
    room.reserved.delete(seat);
  }

  /**
   * Release a seat with the normal leave semantics: drop the occupant and
   * its listeners; destroy an emptied room, else vacate the seat if the
   * match already started. Returns the room info, or null if destroyed.
   */
  function detachSeat(room: RoomEntry, seat: number): RoomInfo | null {
    const occupant = room.seats[seat];
    room.seats[seat] = null;
    if (occupant !== null) {
      room.listeners = room.listeners.filter((l) => l.token !== occupant);
    }

    if (connectedCount(room) === 0) {
      destroyRoom(room); // empty rooms do not linger
      return null;
    }
    if (room.state !== "waiting") {
      // The roster is frozen once the match started: the pawn stays in the
      // match, the seat is simply vacated.
      room.vacated.add(seat);
    }
    return infoOf(room);
  }

  function reserveSeat(token: string, options?: ReserveOptions): ReserveResult {
    if (!validKey(token)) return { ok: false, reason: "unknown-session" };
    const seated = findSeat(token);
    if (!seated) return { ok: false, reason: "not-in-room" };
    const { room, seat } = seated;
    const ms = options?.reservationMs ?? DEFAULT_RESERVATION_MS;

    // Restart the window on re-reserve (double drop, transport retries).
    cancelReservation(room, seat);
    const onExpire = options?.onExpire;
    const timer = setTimeout(() => expireReservation(room, seat, onExpire), ms);
    room.reserved.set(seat, { timer, onExpire });

    // The seat is occupied-but-disconnected now: reserved seats report
    // connected:false in the roster. The transport broadcasts the new
    // room info to the peers on its own reserve hook.
    return { ok: true };
  }

  function expireReservation(
    room: RoomEntry,
    seat: number,
    onExpire: (() => void) | undefined
  ): void {
    // The room may have been destroyed (server teardown) since the timer
    // was armed — a destroyed room's seat list is gone, nothing to do.
    if (rooms.get(room.id) !== room) return;
    room.reserved.delete(seat);
    // Release the seat FIRST (normal leave semantics, listeners already
    // gone — the transport unsubscribed on disconnect), then let the
    // caller revoke the credential: the session can no longer reconnect.
    detachSeat(room, seat);
    onExpire?.();
  }

  function restoreSeat(token: string): RestoreResult {
    if (!validKey(token)) return { ok: false, reason: "unknown-session" };
    const seated = findSeat(token);
    if (!seated) return { ok: false, reason: "not-in-room" };
    const { room, seat } = seated;
    cancelReservation(room, seat);
    // The player is back and connected again — the transport broadcasts
    // the updated room info to the peers on its reconnect path.
    return { ok: true, room: infoOf(room), playerId: `p${seat}` };
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

    const host = createGameHost({
      players: roster,
      // The round decision deadline is room policy: every match started
      // here gets the same server-configured aiming-round maximum.
      roundDecisionTimeoutMs: options?.roundDecisionTimeoutMs,
    });
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

  /**
   * Privileged, server-controlled resolution of the current round — the
   * decision deadline. Every alive player who already confirmed moves
   * (together); unconfirmed players do not move this round. This is the
   * stand-in for the server's round-deadline timer: players cannot
   * submit it over the wire (submitCommand rejects it as unauthorized),
   * exactly like resetMatch.
   */
  function resolveRound(roomId: string): ResolveRoundResult {
    if (!validKey(roomId)) return { ok: false, reason: "unknown-room" };
    const room = rooms.get(roomId);
    if (!room) return { ok: false, reason: "unknown-room" };
    if (!room.host) return { ok: false, reason: "no-match" };
    return room.host.submitCommand({ type: "resolveRound" });
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
        case "resolveRound":
          // Match-level action: privileged. A player must never resolve a
          // round on the other players' behalf — the server calls
          // resolveRound() when the round deadline expires (behind
          // whatever timer policy it enforces).
          return { ok: false, reason: "unauthorized" };
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
    reserveSeat,
    restoreSeat,
    getRoom,
    resolveSeat,
    startMatch,
    resetMatch,
    resolveRound,
    removeEmptyRooms,
    onRoomState,
    roomCount,
    destroy,
    submitCommand,
  };
}
