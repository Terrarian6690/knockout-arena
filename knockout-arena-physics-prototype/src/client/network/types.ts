import type { GameStateSnapshot } from "../../game";

/**
 * Types for the browser-side network client (protocol v1).
 *
 * These are the CLIENT's view of the wire contract. They deliberately do
 * NOT import anything from src/server: server code must never enter the
 * browser bundle, so each side of the protocol owns its end of the contract
 * (mirroring src/server/protocol.ts). The snapshot payload, however, reuses
 * the ENGINE's GameStateSnapshot type (type-only import from the engine
 * barrel) — the client never defines a second game-state shape.
 */

/** Connection lifecycle of the network client. */
export type ConnectionStatus =
  /** Never connected, or reconnect attempts exhausted. */
  | "disconnected"
  /** A first explicit connect() is in flight. */
  | "connecting"
  /** Socket open — messages may be sent. */
  | "connected"
  /** An unexpected drop is being retried (backoff + new handshake). */
  | "reconnecting"
  /** Terminally closed via close() — no further state updates. */
  | "closed";

/** Room lifecycle, as broadcast by the server. */
export type RoomState = "waiting" | "playing" | "finished";

/** One seat in the room roster, as broadcast by the server. */
export interface RosterEntry {
  readonly playerId: string;
  readonly connected: boolean;
  /**
   * The player's chosen display name, or null when they never set one
   * (also when an older server omits the field) — the UI then falls
   * back to the seat-derived "Player N". Purely cosmetic.
   */
  readonly displayName: string | null;
}

/**
 * Everything the UI needs from the network layer. Immutable-by-convention:
 * the store replaces the object on every change (external-store friendly —
 * getState + subscribe match React's useSyncExternalStore contract).
 */
export interface NetworkClientState {
  readonly status: ConnectionStatus;
  readonly roomId: string | null;
  /** The SERVER-assigned seat id for this connection, or null. */
  readonly playerId: string | null;
  readonly roomState: RoomState | null;
  readonly roster: readonly RosterEntry[];
  /** Seat id of the room host (only the host may start the match). */
  readonly hostPlayerId: string | null;
  /** The latest authoritative snapshot, projected for THIS client. */
  readonly snapshot: GameStateSnapshot | null;
  readonly winnerId: string | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  /** Current reconnection attempt number (0 while not reconnecting). */
  readonly reconnectAttempt: number;
}

/**
 * The minimal socket surface the client needs. The browser's WebSocket is
 * adapted to this shape (see websocketClient.ts); tests inject fakes, so
 * the networking core stays environment-independent.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onError(cb: () => void): void;
  onClose(cb: () => void): void;
}

/** Creates the socket for a connection (injectable for tests). */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * Reconnection policy — deliberately isolated so it can be replaced once a
 * server-side seat-reconnection protocol exists. Bounded exponential
 * backoff; retrying NEVER restores the previous seat (there is no
 * reconnection protocol yet — the client reconnects as a fresh session).
 */
export interface ReconnectPolicy {
  readonly enabled: boolean;
  /** Maximum reconnect attempts after one unexpected drop. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  backoffFactor: 2,
};
