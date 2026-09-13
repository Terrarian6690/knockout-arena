import { describe, expect, it } from "vitest";
import { createArena, floorRadius, isPawnOutOfBounds } from "../arena";
import { CONFIG } from "../config";

/**
 * THE ELIMINATION BOUNDARY, PINNED IN ABSOLUTE NUMBERS (Task 23).
 *
 * The documented rule is that a pawn survives until its ENTIRE diameter
 * has left the floor: it dies only once
 *
 *     distance(center, arenaCenter) > floorRadius + pawnRadius
 *
 * An investigation confirmed the implementation already matches that
 * rule exactly, so nothing was changed. What was missing was a test that
 * could actually catch a drift TOWARD the wrong rule.
 *
 * arena.test.ts already covers this behaviourally, but it computes its
 * expectations with `floorRadius(arena) + PAWN_R` — the same expression
 * the implementation uses. If someone "simplified" the check to
 * `> floorRadius(arena)` (the half-out bug), those tests would still
 * pass for any case where the helper and the check drifted together, and
 * the CONFIG-drift case is not covered at all.
 *
 * So this file hard-codes the arithmetic:
 *
 *     outer radius      330
 *   − wall thickness     16
 *   ────────────────────────
 *     floor radius      314
 *   + pawn radius        16
 *   ────────────────────────
 *     ELIMINATION AT    330   (strictly greater than)
 *
 * Every number is written out. If any CONFIG value moves, or the rule is
 * rewritten in terms of the floor alone, these fail loudly.
 */

const CENTER_X = 450;
const CENTER_Y = 350;

describe("the elimination boundary is floor + pawn radius, in absolute units", () => {
  it("derives from the exact CONFIG values this arithmetic assumes", () => {
    // Guard the inputs: if these move, the literals below are stale and
    // the failure should say so here rather than looking like a logic bug.
    expect(CONFIG.arena.radius).toBe(330);
    expect(CONFIG.arena.wallThickness).toBe(16);
    expect(CONFIG.pawn.radius).toBe(16);
    expect(CONFIG.arena.centerX).toBe(CENTER_X);
    expect(CONFIG.arena.centerY).toBe(CENTER_Y);
    expect(floorRadius(createArena())).toBe(314);
  });

  it("eliminates at exactly 330 units — not 314", () => {
    const arena = createArena();
    const at = (d: number) =>
      isPawnOutOfBounds(arena, CENTER_X + d, CENTER_Y, 16);

    // 314 is the floor edge: the pawn is HALF out here. It must live.
    // This is the assertion that fails if the rule ever becomes
    // `distance > floorRadius`.
    expect(at(314)).toBe(false);

    // Every intermediate position is still alive: the pawn is leaving,
    // but some part of it is still over the floor.
    for (const d of [315, 318, 320, 325, 329, 329.999]) {
      expect(at(d)).toBe(false);
    }

    // 330 exactly: the pawn's inner edge grazes the floor edge. The rule
    // is strictly greater-than, so this is the last surviving position.
    expect(at(330)).toBe(false);

    // Past 330: fully clear of the floor, eliminated.
    for (const d of [330.001, 331, 340, 400]) {
      expect(at(d)).toBe(true);
    }
  });

  it("gives the pawn a full 16 units of grace past the floor edge", () => {
    const arena = createArena();
    // The difference between the correct rule and the half-out bug,
    // stated as a number: one whole pawn radius.
    let lastAlive = 314;
    for (let d = 314; d <= 340; d += 0.5) {
      if (!isPawnOutOfBounds(arena, CENTER_X + d, CENTER_Y, 16)) lastAlive = d;
    }
    expect(lastAlive).toBe(330);
    expect(lastAlive - floorRadius(arena)).toBe(16);
    expect(lastAlive - floorRadius(arena)).toBe(CONFIG.pawn.radius);
  });

  it("holds at every radius on the shrink schedule", () => {
    // 330 → 290 → 250 → 210 → 180, and the boundary tracks each one.
    const expected: ReadonlyArray<readonly [number, number, number]> = [
      // [arena radius, floor, elimination distance]
      [330, 314, 330],
      [290, 274, 290],
      [250, 234, 250],
      [210, 194, 210],
      [180, 164, 180],
    ];
    for (const [radius, floor, boundary] of expected) {
      const arena = createArena(radius);
      expect(floorRadius(arena)).toBe(floor);
      expect(
        isPawnOutOfBounds(arena, CENTER_X + boundary, CENTER_Y, 16)
      ).toBe(false); // survives AT the boundary
      expect(
        isPawnOutOfBounds(arena, CENTER_X + boundary + 0.001, CENTER_Y, 16)
      ).toBe(true); // dies just past it
      // …and is emphatically alive at the floor edge (half out).
      expect(isPawnOutOfBounds(arena, CENTER_X + floor, CENTER_Y, 16)).toBe(
        false
      );
    }
  });

  it("is radially symmetric — 330 in every direction, not just +x", () => {
    const arena = createArena();
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2;
      const probe = (d: number) =>
        isPawnOutOfBounds(
          arena,
          CENTER_X + Math.cos(angle) * d,
          CENTER_Y + Math.sin(angle) * d,
          16
        );
      // Floating point: a point placed at exactly 330 by cos/sin can land
      // a hair over, so assert just inside and just outside the boundary.
      expect(probe(329.99)).toBe(false);
      expect(probe(330.01)).toBe(true);
      expect(probe(314)).toBe(false); // half out, alive, at every angle
    }
  });
});

describe("the boundary coincides with the OUTER ring — the perception trap", () => {
  it("puts the death line on the ring's outer edge, not the floor edge", () => {
    // This is why correct behaviour can look early. wallThickness (16)
    // happens to equal the pawn radius (16), so at the instant of death
    // the pawn exactly fills the visual ring band: its inner edge rests
    // on the floor line (314) and its outer edge on the outer border
    // (330). The pawn still LOOKS like it is sitting on the rim.
    const arena = createArena();
    const boundary = floorRadius(arena) + CONFIG.pawn.radius;

    expect(boundary).toBe(arena.radius); // 330 === 330
    expect(CONFIG.arena.wallThickness).toBe(CONFIG.pawn.radius);

    // At the moment of death the pawn spans exactly the ring band.
    const innerEdgeAtDeath = boundary - CONFIG.pawn.radius;
    const outerEdgeAtDeath = boundary + CONFIG.pawn.radius;
    expect(innerEdgeAtDeath).toBe(floorRadius(arena)); // 314
    expect(outerEdgeAtDeath).toBe(arena.radius + CONFIG.pawn.radius); // 346

    // The pawn is drawn at its true radius, so this is genuinely what a
    // player sees — the rendering is not lying, the rim is just wide.
    expect(CONFIG.pawn.radius).toBe(16);
  });

  it("keeps that coincidence at every shrink step", () => {
    for (const radius of [330, 290, 250, 210, 180]) {
      const arena = createArena(radius);
      expect(floorRadius(arena) + CONFIG.pawn.radius).toBe(arena.radius);
    }
  });
});
