/**
 * Public API surface of the headless game server.
 *
 * The server consumes the engine ONLY through its barrel (../game) and is
 * layered as:
 *
 *   session.ts            connection identity (the root of the trust chain)
 *   gameHost.ts           one authoritative match (owns the engine GameHandle)
 *   roomManager.ts        rooms: seats p0..p3, lifecycle, identity stamping
 *   gameServer.ts         the session-facing facade
 *   protocol.ts           the wire protocol (v1) — pure parsing/building
 *   webSocketTransport.ts the ws adapter around the facade
 *
 * The primary entry points are createGameServer() (transport-neutral) and
 * createWebSocketTransport() (real-time wire). The engine stays unaware of
 * all of this; the transport contains no gameplay logic.
 */
export {
  createGameHost,
  DEFAULT_MAX_CATCH_UP_TICKS,
  type GameHost,
  type GameHostOptions,
  type SerializedStateListener,
} from "./gameHost";
export {
  createRoomManager,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type LeaveResult,
  type ResetResult,
  type RoomInfo,
  type RoomManager,
  type RoomSeatInfo,
  type RoomState,
  type SeatResult,
  type ServerCommandRejection,
  type ServerCommandResult,
  type StartResult,
} from "./roomManager";
export {
  createGameServer,
  type GameServer,
} from "./gameServer";
export { createSession, isSession, type Session } from "./session";
export {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ClientMessageRejection,
  type ParsedClientMessage,
  describeError,
  errorMessage,
  matchFinishedMessage,
  parseClientMessage,
  roomStateMessage,
  snapshotMessage,
  welcomeMessage,
  ERROR_DESCRIPTIONS,
} from "./protocol";
export {
  createTransportCore,
  createWebSocketTransport,
  type ConnectionHandle,
  type TransportCore,
  type TransportOptions,
  type TransportSocket,
  type WebSocketTransport,
  type WebSocketTransportOptions,
} from "./webSocketTransport";
