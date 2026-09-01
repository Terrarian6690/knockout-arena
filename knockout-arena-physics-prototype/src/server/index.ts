/**
 * Public API surface of the headless game server.
 *
 * The server consumes the engine ONLY through its barrel (../game) and
 * currently exposes a single abstraction: the authoritative GameHost that
 * owns one match. Transport layers (WebSocket later) will be built on top
 * of this module without touching the engine.
 */
export {
  createGameHost,
  DEFAULT_MAX_CATCH_UP_TICKS,
  type GameHost,
  type GameHostOptions,
  type SerializedStateListener,
} from "./gameHost";
