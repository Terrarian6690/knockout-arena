/**
 * Public API surface of the headless game server.
 *
 * The server consumes the engine ONLY through its barrel (../game) and is
 * layered as:
 *
 *   session.ts     connection identity (the root of the trust chain)
 *   gameHost.ts    one authoritative match (owns the engine GameHandle)
 *   roomManager.ts rooms: seats p0..p3, lifecycle, identity stamping
 *   gameServer.ts  the facade the future transport attaches to
 *
 * The primary entry point is createGameServer(); createRoomManager() and
 * createGameHost() remain available for lower-level reuse. No networking
 * exists in this package — the WebSocket layer will be built on top.
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
