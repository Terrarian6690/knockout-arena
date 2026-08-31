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
 * True when a point center (with given radius) has fully crossed the inner
 * boundary line. We use the center distance so the whole pawn must leave.
 */
export function isPawnOutOfBounds(
  arena: Arena,
  x: number,
  y: number,
  pawnRadius: number
): boolean {
  const dx = x - arena.centerX;
  const dy = y - arena.centerY;
  const dist = Math.hypot(dx, dy);
  return dist > floorRadius(arena) - pawnRadius * 0.4;
}

/** Clamp a point to be just inside the floor (used for safe spawns). */
export function clampToFloor(arena: Arena, x: number, y: number): [number, number] {
  const dx = x - arena.centerX;
  const dy = y - arena.centerY;
  const dist = Math.hypot(dx, dy) || 1;
  const max = floorRadius(arena) - CONFIG.pawn.radius - 4;
  if (dist <= max) return [x, y];
  const scale = max / dist;
  return [arena.centerX + dx * scale, arena.centerY + dy * scale];
}

/** A spawn point near the arena edge, given an angle in radians. */
export function spawnPositionAtAngle(arena: Arena, angle: number): [number, number] {
  const r = floorRadius(arena) - CONFIG.pawn.radius - 8;
  return [
    arena.centerX + Math.cos(angle) * r,
    arena.centerY + Math.sin(angle) * r,
  ];
}
