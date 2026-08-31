import { CONFIG } from "./config";

/**
 * Arena model. Describes the circular boundary the pawns move within and
 * provides helpers for boundary containment / elimination checks.
 *
 * Kept as pure data + math so the same logic can run server-side later.
 */
export interface Arena {
  centerX: number;
  centerY: number;
  radius: number;
  wallThickness: number;
}

export function createArena(): Arena {
  const a = CONFIG.arena;
  return {
    centerX: a.centerX,
    centerY: a.centerY,
    radius: a.radius,
    wallThickness: a.wallThickness,
  };
}

/** The inner floor radius (where the playable surface ends). */
export function floorRadius(arena: Arena): number {
  return arena.radius - arena.wallThickness;
}

/**
 * The single authoritative elimination rule: a pawn is out of bounds when it
 * has completely left the playable floor — the distance from the arena
 * center exceeds the floor radius by more than the pawn's own radius, i.e.
 * no part of the pawn touches the playfield anymore.
 *
 * Pure geometry (no velocity heuristics, no magic thresholds): the same
 * check works identically on client and, later, on a server.
 */
export function isPawnOutOfBounds(
  arena: Arena,
  x: number,
  y: number,
  pawnRadius: number
): boolean {
  const dx = x - arena.centerX;
  const dy = y - arena.centerY;
  return Math.hypot(dx, dy) > floorRadius(arena) + pawnRadius;
}

/** A spawn point just inside the floor, given an angle in radians. */
export function spawnPositionAtAngle(arena: Arena, angle: number): [number, number] {
  const r = floorRadius(arena) - CONFIG.pawn.radius - 8;
  return [
    arena.centerX + Math.cos(angle) * r,
    arena.centerY + Math.sin(angle) * r,
  ];
}
