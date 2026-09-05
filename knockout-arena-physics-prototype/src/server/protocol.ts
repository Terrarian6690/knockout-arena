/**
 * Wire protocol for the WebSocket transport — version 1.
 *
 * PURE module: parsing and message building only. It knows nothing about
 * sockets, sessions, rooms or the game — the transport (webSocketTransport.ts)
 * translates between these messages and the GameServer API, and the server
 * does everything else.
 *
 * Every message, both directions, carries the envelope:
 *
 *   { "protocolVersion": 1, "type": "..." }
 *
 * Client → server (see ClientMessage): create_room, join_room, leave_room,
 * start_match, reconnect, command. The envelope is STRICT: unknown top-level
 * fields are rejected (malformed-payload) so protocol mistakes surface early.
 * The
 * `command` payload is the exception — it is passed to the server verbatim,
 * where unknown fields (including any playerId) are stripped and the
 * session's seat identity is stamped in.
 *
 * Server → client (see ServerMessage): welcome, room_state, snapshot, error,
 * match_finished.
 */

import type { RoomInfo } from "./roomManager";

export const PROTOCOL_VERSION = 1;

// ── client → server ───────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "create_room" }
  // roomId = the player-facing 4-character room code (the manager
  // normalizes it: lowercase and whitespace are tolerated).
  | { type: "join_room"; roomId: string }
  | { type: "leave_room" }
  | { type: "start_match" }
  | { type: "reconnect"; token: string }
  | { type: "command"; command: unknown };

export type ClientMessageRejection =
  /** Not parseable JSON, or not a JSON object (array/null/primitive). */
  | "malformed-message"
  /** Missing or unsupported protocolVersion (this server speaks 1). */
  | "unsupported-protocol"
  /** A JSON object with a version we support but an unknown type. */
  | "unknown-message-type"
  /** Known type, but its fields are missing or of the wrong shape. */
  | "malformed-payload";

export type ParsedClientMessage =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: ClientMessageRejection };

/**
 * Parse and validate one inbound wire message. Total function: any input —
 * invalid JSON, arrays, null, primitives, hostile objects — resolves to a
 * rejection, never a throw.
 */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "malformed-message" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "malformed-message" };
  }
  const envelope = value as Record<string, unknown>;

  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported-protocol" };
  }

  switch (envelope.type) {
    case "create_room":
      if (hasOnly(envelope, "type", "protocolVersion")) {
        return { ok: true, message: { type: "create_room" } };
      }
      return { ok: false, code: "malformed-payload" };

    case "join_room":
      if (
        hasOnly(envelope, "type", "protocolVersion", "roomId") &&
        typeof envelope.roomId === "string" &&
        envelope.roomId.length > 0
      ) {
        return {
          ok: true,
          message: { type: "join_room", roomId: envelope.roomId },
        };
      }
      return { ok: false, code: "malformed-payload" };

    case "leave_room":
      if (hasOnly(envelope, "type", "protocolVersion")) {
        return { ok: true, message: { type: "leave_room" } };
      }
      return { ok: false, code: "malformed-payload" };

    case "start_match":
      if (hasOnly(envelope, "type", "protocolVersion")) {
        return { ok: true, message: { type: "start_match" } };
      }
      return { ok: false, code: "malformed-payload" };

    case "reconnect":
      // The seat-recovery credential. Opaque server-issued value; the
      // server resolves it to exactly one seat — a credential is never
      // a playerId, a roomId, or anything the client gets to choose.
      if (
        hasOnly(envelope, "type", "protocolVersion", "token") &&
        typeof envelope.token === "string" &&
        envelope.token.length > 0
      ) {
        return {
          ok: true,
          message: { type: "reconnect", token: envelope.token },
        };
      }
      return { ok: false, code: "malformed-payload" };

    case "command":
      if (
        hasOnly(envelope, "type", "protocolVersion", "command") &&
        typeof envelope.command === "object" &&
        envelope.command !== null &&
        !Array.isArray(envelope.command)
      ) {
        return {
          ok: true,
          message: { type: "command", command: envelope.command },
        };
      }
      return { ok: false, code: "malformed-payload" };

    default:
      return { ok: false, code: "unknown-message-type" };
  }
}

/** Exact-field strictness helper for the envelope. */
function hasOnly(
  envelope: Record<string, unknown>,
  ...allowed: string[]
): boolean {
  for (const key of Object.keys(envelope)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

// ── server → client ───────────────────────────────────────────────────────

/**
 * The client's seat assignment + room status after create_room, join_room
 * or a successful reconnect. `roomId` carries the room's player-facing
 * 4-character CODE (the internal UUID never crosses the wire).
 * `reconnectToken` is the seat's recovery credential — it appears ONLY
 * here, in this per-connection message, never in broadcasts, rosters or
 * snapshots, and it is NOT the room code (codes locate, credentials
 * authenticate).
 */
export function welcomeMessage(
  roomId: string,
  playerId: string,
  room: RoomInfo,
  reconnectToken: string
): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "welcome",
    roomId,
    playerId,
    roomState: room.state,
    roster: room.seats,
    hostPlayerId: room.hostPlayerId,
    reconnectToken,
  });
}

/**
 * Roster/room-state change, broadcast to the members of a room. As on the
 * welcome, `roomId` is the player-facing room code.
 */
export function roomStateMessage(room: RoomInfo): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "room_state",
    roomId: room.code,
    roomState: room.state,
    roster: room.seats,
    hostPlayerId: room.hostPlayerId,
  });
}

/**
 * One authoritative match state, projected for the receiving client's own
 * pawn (the payload is the engine's GameStateSnapshot — reused, not
 * redefined — plus one server-stamped presentation field,
 * `state.roundDeadline`: the current aiming round's absolute decision
 * deadline, or null). The transport does not interpret it.
 */
export function snapshotMessage(view: unknown): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "snapshot",
    state: view,
  });
}

/** Machine-readable rejection with a human-readable description. */
export function errorMessage(code: string, message: string): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    code,
    message,
  });
}

/** Sent once when the room's match reaches the finished phase. */
export function matchFinishedMessage(winnerId: string | null): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "match_finished",
    winnerId,
  });
}

/** Human-readable descriptions for every rejection code we emit. */
export const ERROR_DESCRIPTIONS: Record<string, string> = {
  "malformed-message":
    "the message is not a JSON protocol object",
  "unsupported-protocol":
    "unsupported protocolVersion (this server speaks version 1)",
  "unknown-message-type": "unknown message type",
  "malformed-payload": "the message fields do not match the protocol",
  "internal-error": "unexpected server error while handling the message",
  // Server-level rejections, passed through with their reasons:
  "unknown-session": "no such session",
  "already-in-room": "already in a room — leave it first",
  "unknown-room": "no such room",
  "room-full": "the room is full (4 players)",
  "room-playing": "the match has already started",
  "not-in-room": "not in a room",
  "no-match": "no match is running in this room",
  "not-enough-players": "at least 2 players are required to start",
  "already-playing": "the match is already running",
  unauthorized: "not allowed for this session",
  "invalid-reconnect": "the reconnect credential is invalid or expired",
  "invalid-command": "the command is malformed",
  "wrong-player": "the player is eliminated",
  "wrong-phase": "the command is not allowed in the current phase",
  "already-confirmed": "the move is locked in for this round — wait for the next one",
};

export function describeError(code: string): string {
  return ERROR_DESCRIPTIONS[code] ?? "rejected";
}
