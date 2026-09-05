import type { GameStateSnapshot, PlayerIntent } from "../../game";
import type { RosterEntry, RoomState } from "./types";

/**
 * The browser-side end of wire protocol v1 — pure parsing and building.
 *
 * Mirrors the server's contract (src/server/protocol.ts) without importing
 * it: each side owns its end of the wire, keeping server code out of the
 * browser bundle. This module knows nothing about sockets, React or state.
 *
 * Client → server envelopes (built here): create_room, join_room,
 * leave_room, start_match, reconnect, command. The command payload is REBUILT
 * from known intent fields only — a playerId or any extra field a caller
 * tries to attach is dropped before the wire, because identity is assigned by
 * the server from the session, never claimed by the client. The reconnect
 * credential is the exception: it is the opaque value the server issued for
 * THIS seat, echoed back verbatim — it resolves to exactly that one seat,
 * never to a chosen playerId/room.
 *
 * Server → client messages (parsed here): welcome, room_state, snapshot,
 * match_finished, error. parseServerMessage is a total function — anything
 * malformed resolves to a rejection, never a throw. The snapshot payload is
 * the engine's GameStateSnapshot: validation here is a loose crash-guard
 * (the server is the trusted, authoritative side), not a security check.
 */

export const PROTOCOL_VERSION = 1;

// ── client → server ───────────────────────────────────────────────────────

export function createRoomMessage(): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "create_room" });
}

export function joinRoomMessage(roomId: string): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "join_room",
    roomId,
  });
}

export function leaveRoomMessage(): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "leave_room" });
}

/**
 * set_name: the sender's OWN display name. No playerId field exists —
 * the server derives the seat from the session (see protocol.ts).
 */
export function setNameMessage(name: string): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "set_name", name });
}

export function startMatchMessage(): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "start_match" });
}

/**
 * The seat-recovery handshake: present the reconnect credential this
 * client's seat was issued (in its personal welcome message). The server
 * resolves the credential to exactly one seat — the client never chooses
 * a room or playerId on this path.
 */
export function reconnectMessage(token: string): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "reconnect", token });
}

/**
 * Rebuild a client intent from known fields only. Returns null for anything
 * that is not a valid client intent — including `reset`, which is a
 * server-only match operation and must never be sent by a client.
 */
export function commandPayload(intent: unknown): PlayerIntent | null {
  try {
    if (typeof intent !== "object" || intent === null) return null;
    const value = intent as Record<string, unknown>;
    switch (value.type) {
      case "aim":
        return { type: "aim", x: value.x as number, y: value.y as number };
      case "setPower":
        return { type: "setPower", power: value.power as number };
      case "confirmLaunch":
        return { type: "confirmLaunch" };
      default:
        return null;
    }
  } catch {
    // Hostile getters must not throw past this boundary.
    return null;
  }
}

export function commandMessage(intent: unknown): string | null {
  const payload = commandPayload(intent);
  if (payload === null) return null;
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "command",
    command: payload,
  });
}

// ── server → client ───────────────────────────────────────────────────────

export type ServerMessage =
  | {
      type: "welcome";
      roomId: string;
      playerId: string;
      roomState: RoomState;
      roster: RosterEntry[];
      hostPlayerId: string | null;
      /**
       * This seat's reconnect credential — present in create/join/reconnect
       * welcomes. Absent in older servers: the client then simply has no
       * recovery path (fresh-session behavior). Never broadcast.
       */
      reconnectToken?: string;
    }
  | {
      type: "room_state";
      roomId: string | null;
      roomState: RoomState;
      roster: RosterEntry[];
      hostPlayerId: string | null;
    }
  | { type: "snapshot"; state: GameStateSnapshot }
  | { type: "match_finished"; winnerId: string | null }
  | { type: "error"; code: string; message: string };

export type ServerMessageRejection =
  | "malformed-message"
  | "unsupported-protocol"
  | "unknown-message-type"
  | "malformed-payload";

export type ParsedServerMessage =
  | { ok: true; message: ServerMessage }
  | { ok: false; code: ServerMessageRejection; description: string };

/** Parse one inbound server message. Total function: never throws. */
export function parseServerMessage(raw: string): ParsedServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return reject("malformed-message", "the message is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject("malformed-message", "the message is not a JSON object");
  }
  const envelope = value as Record<string, unknown>;

  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return reject(
      "unsupported-protocol",
      "unsupported protocolVersion (this client speaks version 1)"
    );
  }

  switch (envelope.type) {
    case "welcome": {
      if (!isNonEmptyString(envelope.roomId) || !isNonEmptyString(envelope.playerId)) {
        return reject("malformed-payload", "welcome needs roomId and playerId");
      }
      const roomState = asRoomState(envelope.roomState);
      const roster = asRoster(envelope.roster);
      const hostPlayerId = asPlayerIdOrNull(envelope.hostPlayerId);
      // The credential is optional (older servers): absent is fine, but
      // anything present must be an opaque non-empty string (or null).
      const reconnectToken =
        envelope.reconnectToken === undefined
          ? null
          : asPlayerIdOrNull(envelope.reconnectToken);
      if (
        roomState === null ||
        roster === null ||
        hostPlayerId === undefined ||
        reconnectToken === undefined
      ) {
        return reject("malformed-payload", "welcome has a malformed room payload");
      }
      return {
        ok: true,
        message: {
          type: "welcome",
          roomId: envelope.roomId,
          playerId: envelope.playerId,
          roomState,
          roster,
          hostPlayerId,
          ...(reconnectToken !== null ? { reconnectToken } : {}),
        },
      };
    }

    case "room_state": {
      const roomState = asRoomState(envelope.roomState);
      const roster = asRoster(envelope.roster);
      const hostPlayerId = asPlayerIdOrNull(envelope.hostPlayerId);
      const roomId =
        envelope.roomId === undefined ? null : asPlayerIdOrNull(envelope.roomId) ?? null;
      if (
        roomState === null ||
        roster === null ||
        hostPlayerId === undefined ||
        (envelope.roomId !== undefined && !isNonEmptyString(envelope.roomId))
      ) {
        return reject("malformed-payload", "room_state has a malformed room payload");
      }
      return {
        ok: true,
        message: { type: "room_state", roomId, roomState, roster, hostPlayerId },
      };
    }

    case "snapshot": {
      const state = envelope.state;
      if (typeof state !== "object" || state === null || Array.isArray(state)) {
        return reject("malformed-payload", "snapshot has no state object");
      }
      const snapshot = state as Record<string, unknown>;
      // Loose crash-guard only — the server is authoritative and trusted.
      if (
        typeof snapshot.phase !== "string" ||
        !Array.isArray(snapshot.pawns) ||
        (snapshot.localPawnId !== null && typeof snapshot.localPawnId !== "string") ||
        (snapshot.winnerId !== null && typeof snapshot.winnerId !== "string")
      ) {
        return reject("malformed-payload", "snapshot state is not a GameStateSnapshot");
      }
      return { ok: true, message: { type: "snapshot", state: state as GameStateSnapshot } };
    }

    case "match_finished": {
      if (envelope.winnerId === null || typeof envelope.winnerId === "string") {
        return {
          ok: true,
          message: { type: "match_finished", winnerId: envelope.winnerId },
        };
      }
      return reject("malformed-payload", "match_finished needs winnerId");
    }

    case "error": {
      if (isNonEmptyString(envelope.code) && typeof envelope.message === "string") {
        return {
          ok: true,
          message: { type: "error", code: envelope.code, message: envelope.message },
        };
      }
      return reject("malformed-payload", "error needs code and message");
    }

    default:
      return reject("unknown-message-type", "unknown server message type");
  }
}

// ── validation helpers ────────────────────────────────────────────────────

function reject(code: ServerMessageRejection, description: string): ParsedServerMessage {
  return { ok: false, code, description };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asRoomState(value: unknown): RoomState | null {
  return value === "waiting" || value === "playing" || value === "finished"
    ? value
    : null;
}

/** Returns the roster, null if malformed. */
function asRoster(value: unknown): RosterEntry[] | null {
  if (!Array.isArray(value)) return null;
  const roster: RosterEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const seat = entry as Record<string, unknown>;
    if (!isNonEmptyString(seat.playerId) || typeof seat.connected !== "boolean") {
      return null;
    }
    // displayName is additive (v1): absent on older servers and for
    // players who never set one → null → the seat-derived fallback.
    // When present it must be a string, or the payload is malformed.
    let displayName: string | null = null;
    if (seat.displayName !== undefined && seat.displayName !== null) {
      if (typeof seat.displayName !== "string") return null;
      displayName = seat.displayName;
    }
    roster.push({ playerId: seat.playerId, connected: seat.connected, displayName });
  }
  return roster;
}

/** string → string, null → null, anything else → undefined (invalid). */
function asPlayerIdOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (isNonEmptyString(value)) return value;
  return undefined;
}
