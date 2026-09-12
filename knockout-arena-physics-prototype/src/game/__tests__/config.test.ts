import { describe, expect, it } from "vitest";
import { CONFIG, launchSpeedFor } from "../config";

describe("CONFIG", () => {
  it("exposes a fixed 60 Hz simulation timestep", () => {
    expect(CONFIG.simulation.fixedTimestepMs).toBe(1000 / 60);
  });

  it("clamps big frame gaps above the fixed timestep", () => {
    expect(CONFIG.simulation.maxFrameMs).toBeGreaterThanOrEqual(
      CONFIG.simulation.fixedTimestepMs
    );
  });

  it("has a sane settle threshold and timeout", () => {
    expect(CONFIG.simulation.restSpeedThreshold).toBeGreaterThan(0);
    expect(CONFIG.simulation.maxSettleTicks).toBeGreaterThan(0);
  });

  it("defines a valid power range with the default inside it", () => {
    expect(CONFIG.power.min).toBeLessThan(CONFIG.power.max);
    expect(CONFIG.power.default).toBeGreaterThanOrEqual(CONFIG.power.min);
    expect(CONFIG.power.default).toBeLessThanOrEqual(CONFIG.power.max);
  });

  it("defines an arena whose floor is positive", () => {
    expect(CONFIG.arena.radius).toBeGreaterThan(CONFIG.arena.wallThickness);
    expect(CONFIG.arena.radius - CONFIG.arena.wallThickness).toBeGreaterThan(0);
  });
});

describe("launchSpeedFor", () => {
  it("returns the tuned speed for every power level", () => {
    // 10.8 * (p/5)^1.5 — exactly 3× the original 3.6-based curve, so the
    // relative differences between powers 1–5 are unchanged.
    expect(launchSpeedFor(1)).toBeCloseTo(0.9660, 3);
    expect(launchSpeedFor(2)).toBeCloseTo(2.7322, 3);
    expect(launchSpeedFor(3)).toBeCloseTo(5.0194, 3);
    expect(launchSpeedFor(4)).toBeCloseTo(7.7279, 3);
    expect(launchSpeedFor(5)).toBeCloseTo(10.8, 6);
  });

  it("scales every level by exactly 3× over the original tune", () => {
    // The original speeds (3.6 * (p/5)^1.5) times three — the curve
    // exponent is untouched, only the magnitude tripled.
    const original = [
      0.3219937887599698, 0.9107359661284934, 1.673128805561604,
      2.575950310079758, 3.6,
    ];
    for (let p = CONFIG.power.min; p <= CONFIG.power.max; p++) {
      expect(launchSpeedFor(p)).toBeCloseTo(3 * original[p - 1], 9);
    }
  });

  it("clamps power below the minimum", () => {
    expect(launchSpeedFor(0)).toBe(launchSpeedFor(CONFIG.power.min));
    expect(launchSpeedFor(-42)).toBe(launchSpeedFor(CONFIG.power.min));
  });

  it("clamps power above the maximum", () => {
    expect(launchSpeedFor(6)).toBe(launchSpeedFor(CONFIG.power.max));
    expect(launchSpeedFor(999)).toBe(launchSpeedFor(CONFIG.power.max));
  });

  it("increases monotonically with power", () => {
    for (let p = CONFIG.power.min; p < CONFIG.power.max; p++) {
      expect(launchSpeedFor(p + 1)).toBeGreaterThan(launchSpeedFor(p));
    }
  });

  it("keeps the gameplay invariant: no clearing threshold — every power level launches freely", () => {
    // The arena has no physical wall, so there is no minimum speed a
    // launch must beat: every level (even the gentle power-1 nudge)
    // leaves the floor unimpeded when aimed outward. Pinned physically
    // in physics.test.ts ("no outer wall") and game.test.ts.
    for (let p = CONFIG.power.min; p <= CONFIG.power.max; p++) {
      expect(launchSpeedFor(p)).toBeGreaterThan(0);
    }
  });
});
