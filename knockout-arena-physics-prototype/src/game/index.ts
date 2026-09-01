/**
 * Public API surface of the game engine — the package boundary.
 *
 * This is the ONLY module outside code (the React client today, the
 * authoritative multiplayer server later, bots, replays, tooling) should
 * import. Everything else in src/game is an internal implementation module
 * and may change freely.
 *
 * The boundary is enforced by tests (see __tests__/dom-free.test.ts and
 * __tests__/api.test.ts):
 *   - engine modules are DOM-free/headless and never import React or any
 *     client code (src/game is fully self-contained; matter-js is its only
 *     external dependency);
 *   - this barrel exposes exactly the intended public API — no internals,
 *     no Matter.js types, no UI code.
 *
 * Deliberately NOT exported here:
 *   - the React client hook and the canvas renderer (they live in src/client);
 *   - the physics facade, turn state machine internals and Matter.js types —
 *     those are engine implementation details behind createGame().
 */

// ── Simulation ────────────────────────────────────────────────────────────
export { createGame, type GameHandle, type GameOptions, type PlayerSpec } from "./game";

// ── Commands (player intent + ownership) ──────────────────────────────────
export type {
  GameCommand,
  PlayerIntent,
  CommandResult,
  CommandRejection,
} from "./commands";
export { validateCommand, withPlayerId } from "./commands";

// ── Authoritative state (serialization boundary) ──────────────────────────
export type { GameState, PawnState, PawnAimState } from "./state";
export {
  validateGameState,
  serializeGameState,
  deserializeGameState,
} from "./state";

// ── Client/view projection ────────────────────────────────────────────────
export type { GamePhase, GameStateSnapshot, PawnSnapshot, Vec2 } from "./types";
export { projectSnapshot } from "./project";

// ── World model + tuning ──────────────────────────────────────────────────
// The arena geometry and every tuning constant (including the color palette)
// are owned by the engine so that any renderer — this client, a spectating
// client, a server-side preview — draws the same world.
export { createArena, floorRadius, type Arena } from "./arena";
export { CONFIG } from "./config";
export { playerColor, playerStroke } from "./player";
export { indicatorLength } from "./aiming";
