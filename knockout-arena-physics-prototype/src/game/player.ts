import { CONFIG } from "./config";
import { createAimState, type AimState } from "./aiming";

/**
 * Player / pawn model.
 *
 * The player is a small, engine-agnostic value object describing the pawn.
 * The actual physics body is created by `physics.ts` (Matter.js), keeping the
 * domain logic clean and separable from the physics implementation.
 *
 * Each player owns their own aim + power selection: they persist across
 * other players' turns and are consumed at launch, so a future server can
 * apply "aim"/"setPower" commands to exactly the pawn that issued them.
 *
 * Later phases will attach an authoritative owner id, bot flag, etc. here.
 */
export interface Player {
  /** Stable id ("p0", "p1", ... — one per participant). */
  id: string;
  name: string;
  colorIndex: number;
  radius: number;
  /** Spawn position (near the arena edge). */
  spawnX: number;
  spawnY: number;
  /** Runtime flags, mutated by the engine as turns progress. */
  eliminated: boolean;
  /** This player's selected power level (1..5). */
  power: number;
  /** This player's aim selection. */
  aim: AimState;
}

export interface PlayerInput {
  id: string;
  name: string;
  colorIndex: number;
  spawnX: number;
  spawnY: number;
}

export function createPlayer(input: PlayerInput): Player {
  return {
    id: input.id,
    name: input.name,
    colorIndex: input.colorIndex,
    radius: CONFIG.pawn.radius,
    spawnX: input.spawnX,
    spawnY: input.spawnY,
    eliminated: false,
    power: CONFIG.power.default,
    aim: createAimState(),
  };
}

/** Palette of distinct player colors (more can be added for 6 players). */
export const PLAYER_COLORS: string[] = [
  "#ff8a3d", // orange
  "#4cc9f0", // cyan
  "#f94144", // red
  "#90be6d", // green
  "#f9c74f", // yellow
  "#b388ff", // violet
];

/** Lighter stroke variant per color for the pawn outline. */
export const PLAYER_STROKES: string[] = [
  "#ffd1a1",
  "#b7e9fb",
  "#ffb3b3",
  "#bfe6a1",
  "#ffe6a1",
  "#e0c8ff",
];

export function playerColor(index: number): string {
  return PLAYER_COLORS[wrapIndex(index, PLAYER_COLORS.length)];
}

export function playerStroke(index: number): string {
  return PLAYER_STROKES[wrapIndex(index, PLAYER_STROKES.length)];
}

/** Array index wrapped into [0, len) — safe for negative and huge indices. */
function wrapIndex(index: number, len: number): number {
  return ((index % len) + len) % len;
}
