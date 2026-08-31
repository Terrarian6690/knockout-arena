import { CONFIG, launchSpeedFor } from "./config";
import type { Vec2 } from "./types";

/**
 * Aiming state + math, isolated so it can be unit-tested and reused by bots
 * later (bots can compute a target angle using the same helpers).
 */
export interface AimState {
  /** Current aim direction as a unit vector (points from pawn toward cursor). */
  direction: Vec2;
  /** Whether a valid aim direction has been set. */
  active: boolean;
}

export function createAimState(): AimState {
  return {
    direction: { x: 0, y: -1 },
    active: false,
  };
}

/** Update the aim direction from pawn position toward a world-space target. */
export function aimAt(from: Vec2, target: Vec2): Vec2 | null {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return null;
  return { x: dx / len, y: dy / len };
}

/**
 * Compute the launch velocity vector for a given aim direction + power level.
 * Magnitude is scaled by the tuned launch curve in config.
 */
export function launchVelocity(direction: Vec2, power: number): Vec2 {
  const speed = launchSpeedFor(power);
  return {
    x: direction.x * speed,
    y: direction.y * speed,
  };
}

/** Length of the rendered aim indicator for a power level. */
export function indicatorLength(power: number): number {
  const { min, max } = CONFIG.power;
  const { indicatorLength, minLength, maxLength } = CONFIG.aiming;
  const t = (power - min) / (max - min);
  const base = indicatorLength + t * (maxLength - indicatorLength);
  return Math.min(maxLength, Math.max(minLength, base));
}
