import { CONFIG } from "./config";

/**
 * Player / pawn model.
 *
 * The player is a small, engine-agnostic value object describing the pawn.
 * The actual physics body is created by `physics.ts` (Matter.js), keeping the
 * domain logic clean and separable from the physics implementation.
 *
 * Later phases will attach an authoritative owner id, bot flag, etc. here.
 */
export interface Player {
  /** Stable id (in phase 1 there is exactly one: "p0"). */
  id: string;
  name: string;
  colorIndex: number;
  radius: number;
  /** Spawn position (near the arena edge). */
  spawnX: number;
  spawnY: number;
  /** Runtime flags, mutated by the engine as turns progress. */
  eliminated: boolean;
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
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

export function playerStroke(index: number): string {
  return PLAYER_STROKES[index % PLAYER_STROKES.length];
}
