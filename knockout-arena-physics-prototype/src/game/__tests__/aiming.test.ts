import { describe, expect, it } from "vitest";
import { CONFIG, launchSpeedFor } from "../config";
import {
  aimAt,
  createAimState,
  indicatorLength,
  launchVelocity,
} from "../aiming";

describe("createAimState", () => {
  it("starts inactive pointing up", () => {
    const aim = createAimState();
    expect(aim.active).toBe(false);
    expect(aim.direction).toEqual({ x: 0, y: -1 });
  });
});

describe("aimAt", () => {
  it("aims right", () => {
    expect(aimAt({ x: 0, y: 0 }, { x: 10, y: 0 })).toEqual({ x: 1, y: 0 });
  });

  it("aims left", () => {
    expect(aimAt({ x: 0, y: 0 }, { x: -10, y: 0 })).toEqual({ x: -1, y: 0 });
  });

  it("aims up", () => {
    expect(aimAt({ x: 0, y: 0 }, { x: 0, y: -10 })).toEqual({ x: 0, y: -1 });
  });

  it("aims down", () => {
    expect(aimAt({ x: 0, y: 0 }, { x: 0, y: 10 })).toEqual({ x: 0, y: 1 });
  });

  it("measures from the pawn position, not the world origin", () => {
    const dir = aimAt({ x: 450, y: 110 }, { x: 450, y: 460 });
    expect(dir).toEqual({ x: 0, y: 1 });
  });

  it("returns a unit vector for diagonal targets", () => {
    const dir = aimAt({ x: 0, y: 0 }, { x: 3, y: 4 })!;
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(1, 12);
    expect(dir.x / dir.y).toBeCloseTo(3 / 4, 12);
  });

  it("returns null for a degenerate (too close) target", () => {
    expect(aimAt({ x: 100, y: 100 }, { x: 100, y: 100 })).toBeNull();
    expect(aimAt({ x: 100, y: 100 }, { x: 100.0005, y: 100 })).toBeNull();
  });
});

describe("launchVelocity", () => {
  it("scales the aim direction by the tuned launch speed", () => {
    for (let power = CONFIG.power.min; power <= CONFIG.power.max; power++) {
      const dir = { x: 0.6, y: 0.8 }; // unit
      const v = launchVelocity(dir, power);
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(launchSpeedFor(power), 12);
      expect(v.x).toBeCloseTo(0.6 * launchSpeedFor(power), 12);
      expect(v.y).toBeCloseTo(0.8 * launchSpeedFor(power), 12);
    }
  });

  it("preserves the aim direction", () => {
    const v = launchVelocity({ x: 0, y: -1 }, 4);
    expect(v.x).toBe(0);
    expect(v.y).toBeLessThan(0);
  });
});

describe("indicatorLength", () => {
  it("uses the base length at minimum power", () => {
    expect(indicatorLength(CONFIG.power.min)).toBe(CONFIG.aiming.indicatorLength);
  });

  it("reaches the maximum length at maximum power", () => {
    expect(indicatorLength(CONFIG.power.max)).toBe(CONFIG.aiming.maxLength);
  });

  it("interpolates for mid power", () => {
    const { min, max } = CONFIG.power;
    const mid = (min + max) / 2;
    const expected =
      CONFIG.aiming.indicatorLength +
      ((mid - min) / (max - min)) *
        (CONFIG.aiming.maxLength - CONFIG.aiming.indicatorLength);
    expect(indicatorLength(mid)).toBeCloseTo(expected, 9);
  });

  it("grows monotonically with power", () => {
    for (let p = CONFIG.power.min; p < CONFIG.power.max; p++) {
      expect(indicatorLength(p + 1)).toBeGreaterThan(indicatorLength(p));
    }
  });

  it("clamps out-of-range powers to the configured bounds", () => {
    expect(indicatorLength(0)).toBeGreaterThanOrEqual(CONFIG.aiming.minLength);
    expect(indicatorLength(99)).toBeLessThanOrEqual(CONFIG.aiming.maxLength);
  });
});
