// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  computeTransform,
  computeTransformWithArenaFit,
} from "../renderer";
import { CONFIG } from "../../game";

/**
 * The portrait arena fit: the world is landscape (900×700), so on a
 * portrait canvas the plain contain-fit binds on width and strands the
 * CIRCULAR floor in side gutters. computeTransformWithArenaFit fits
 * the arena circle to the shorter side instead — nothing actionable
 * ever renders outside it. Landscape canvases are untouched.
 */

const R = CONFIG.arena.radius; // 330 — the boundary ring's outer edge

describe("computeTransformWithArenaFit", () => {
  it("landscape canvases keep the plain world fit, byte for byte", () => {
    for (const [w, h] of [
      [1200, 800],
      [900, 700],
      [1024, 768],
    ]) {
      expect(computeTransformWithArenaFit(w, h, R)).toEqual(
        computeTransform(w, h)
      );
    }
  });

  it("portrait: the arena circle spans the canvas width (minus a breathing margin)", () => {
    // A typical phone: the arena column beside the half-width rail.
    const w = 295;
    const h = 560;
    const t = computeTransformWithArenaFit(w, h, R);

    // The circle's diameter in screen space fills the width, 6px clear
    // on each side.
    const circleLeft = t.offsetX + (CONFIG.arena.centerX - R) * t.scale;
    const circleRight = t.offsetX + (CONFIG.arena.centerX + R) * t.scale;
    expect(circleLeft).toBeCloseTo(6, 5);
    expect(circleRight).toBeCloseTo(w - 6, 5);

    // And it is strictly bigger than what the world fit gave (which
    // left ~52px gutters on each side of the circle).
    const base = computeTransform(w, h);
    expect(t.scale).toBeGreaterThan(base.scale * 1.2);
  });

  it("portrait: the circle is vertically centred and never cropped", () => {
    const w = 295;
    const h = 560;
    const t = computeTransformWithArenaFit(w, h, R);
    const circleTop = t.offsetY + (CONFIG.arena.centerY - R) * t.scale;
    const circleBottom = t.offsetY + (CONFIG.arena.centerY + R) * t.scale;
    expect(circleTop).toBeGreaterThanOrEqual(0);
    expect(circleBottom).toBeLessThanOrEqual(h);
    expect((circleTop + circleBottom) / 2).toBeCloseTo(h / 2, 5);
  });

  it("never shrinks below the plain world fit", () => {
    // Degenerate inputs aside, the circle fit is the larger one in
    // portrait; the max() guard keeps the promise absolute.
    const t = computeTransformWithArenaFit(200, 900, R);
    const base = computeTransform(200, 900);
    expect(t.scale).toBeGreaterThanOrEqual(base.scale);
  });
});
