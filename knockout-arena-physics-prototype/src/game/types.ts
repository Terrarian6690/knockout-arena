/**
 * Shared types bridging the engine core and the React UI.
 *
 * These are intentionally engine-agnostic where possible so that a future
 * server-authoritative backend can reuse the same shapes.
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

/** The high-level phase of a match / turn. */
export type GamePhase =
  | "aiming"
  | "moving"
  | "eliminated"
  | "gameOver";

/** Immutable-ish summary of game state fed to the UI each frame. */
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

/** Input actions the UI can dispatch to the engine. */
export type GameAction =
  | { type: "aim"; x: number; y: number } // world-space aim target
  | { type: "setPower"; power: number }
  | { type: "confirmLaunch" }
  | { type: "reset" };

/** Callback used by the engine to push state to the UI. */
export type StateListener = (state: GameStateSnapshot) => void;
