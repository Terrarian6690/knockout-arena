/**
 * View types bridging the engine core and the React UI.
 *
 * These describe what the CLIENT needs (rendering, input, presentation).
 * Authoritative, serializable state lives in state.ts; player intentions
 * (commands) live in commands.ts.
 */

/** A 2D vector in world coordinates. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Snapshot of a single pawn for rendering / UI. */
export interface PawnSnapshot {
  /** Stable id within the match. */
  id: string;
  position: Vec2;
  velocity: Vec2;
  /** Radius in world units. */
  radius: number;
  /** Whether this pawn has been knocked out of the arena. */
  eliminated: boolean;
  /** Whether this pawn is currently moving (during a turn). */
  isMoving: boolean;
  /** Color key (index into the player palette). */
  colorIndex: number;
}

/**
 * The explicit phase of a match. The engine is in exactly one phase at a
 * time and every input is gated by it:
 *
 *   aiming     — the active pawn may aim and pick a power level (1 launch).
 *   moving     — the launch is resolving; physics runs until the pawn settles.
 *   eliminated — the pawn left the arena; only `reset` is accepted.
 *
 * A separate "finished / match over" phase is deliberately deferred to the
 * multiplayer phase: single-player has no win condition beyond elimination,
 * so adding it now would only create an unreachable state.
 */
export type GamePhase = "aiming" | "moving" | "eliminated";

/**
 * Immutable-ish summary of game state fed to the UI each frame. This is a
 * CLIENT-FACING PROJECTION of GameState (see state.ts): it adds presentation
 * flags (isMoving, isAiming, localPawnId) and omits reconstruction details.
 * It is what a future networked client will render from.
 */
export interface GameStateSnapshot {
  phase: GamePhase;
  pawns: PawnSnapshot[];
  /** The pawn id controlled locally (only one in phase 1). */
  localPawnId: string | null;
  /** Selected power level (1..5). */
  power: number;
  /** Aim direction as a unit vector, or null when not aiming. */
  aimDirection: Vec2 | null;
  /** Whether there is an aim target to draw. */
  isAiming: boolean;
  /** Which pawn currently acts (index for turn order later). */
  activePawnId: string | null;
}

/** Callback used by the engine to push state to the UI. */
export type StateListener = (state: GameStateSnapshot) => void;
