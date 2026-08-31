/**
 * Public API surface of the game engine.
 *
 * This is the import a future authoritative server (or any headless host)
 * should use: the simulation, its command model, and its serializable state.
 * Deliberately NOT exported here:
 *   - the React client hook (UI integration)
 *   - renderer.ts — canvas presentation
 *   - config/arena/aiming/… internals — reachable via their modules if
 *     needed, but the stable surface is what is listed below.
 */
export { createGame, type GameHandle } from "./game";
export type { GameCommand, CommandResult, CommandRejection } from "./commands";
export { validateCommand } from "./commands";
export type { GameState, PawnState } from "./state";
export {
  validateGameState,
  serializeGameState,
  deserializeGameState,
} from "./state";
export type { GamePhase, GameStateSnapshot, PawnSnapshot, Vec2 } from "./types";
export { projectSnapshot } from "./project";
