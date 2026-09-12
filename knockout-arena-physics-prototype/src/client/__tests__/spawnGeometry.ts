import { expect } from "vitest";
import { CONFIG, createArena, spawnPositionForSlot } from "../../game";

/**
 * Spawn-derived geometry for client tests.
 *
 * Seats spawn on the arena's FIXED slot ring (see arena.ts), so "aim at
 * the center" produces a different unit vector for every seat. Tests
 * that assert aim/launch directions derive them from here instead of
 * hard-coding axis-aligned literals — that way the one spawn-position
 * source of truth stays authoritative and a future slot-order change
 * cannot leave stale expectations behind.
 */

/** The arena center — the natural, always-valid aim target. */
export const AIM_AT_CENTER = {
  x: CONFIG.arena.centerX,
  y: CONFIG.arena.centerY,
};

/**
 * Per-seat unit vector pointing from that seat's spawn to the center:
 * the exact direction the engine records when a seat aims at the middle.
 */
export const INWARD_UNIT: readonly { x: number; y: number }[] = Array.from(
  { length: CONFIG.match.maxPlayers },
  (_, slot) => {
    const [sx, sy] = spawnPositionForSlot(createArena(), slot);
    const dx = CONFIG.arena.centerX - sx;
    const dy = CONFIG.arena.centerY - sy;
    const len = Math.hypot(dx, dy);
    return { x: dx / len, y: dy / len };
  }
);

/**
 * Assert a projected direction equals an expected unit vector. Uses
 * closeTo because the values come out of trigonometry, not literals.
 */
export function expectDirection(
  actual: { x: number; y: number } | null | undefined,
  expected: { x: number; y: number }
): void {
  expect(actual).not.toBeNull();
  expect(actual).not.toBeUndefined();
  expect(actual!.x).toBeCloseTo(expected.x, 9);
  expect(actual!.y).toBeCloseTo(expected.y, 9);
}
