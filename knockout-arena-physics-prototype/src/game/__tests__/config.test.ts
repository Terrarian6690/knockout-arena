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
    // 3.6 * (p/5)^1.5
    expect(launchSpeedFor(1)).toBeCloseTo(0.3219, 3);
    expect(launchSpeedFor(2)).toBeCloseTo(0.9107, 3);
    expect(launchSpeedFor(3)).toBeCloseTo(1.6731, 3);
    expect(launchSpeedFor(4)).toBeCloseTo(2.5758, 3);
    expect(launchSpeedFor(5)).toBeCloseTo(3.6, 6);
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

  it("keeps the gameplay invariant: max power clears the rim speed, mid power does not", () => {
    expect(launchSpeedFor(CONFIG.power.max)).toBeGreaterThan(
      CONFIG.launch.knockoutSpeed
    );
    expect(launchSpeedFor(3)).toBeLessThan(CONFIG.launch.knockoutSpeed);
  });
});
