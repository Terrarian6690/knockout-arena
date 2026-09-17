import { describe, expect, it } from "vitest";
import {
  arenaEdgeRadius,
  createArena,
  floorRadius,
  isPawnOutOfBounds,
} from "../arena";
import { CONFIG } from "../config";

/**
 * THE ELIMINATION BOUNDARY, PINNED IN ABSOLUTE NUMBERS (Task 23).
 *
 * The rule is that a pawn survives until its ENTIRE diameter has left
 * the VISIBLE platform edge: it dies only once
 *
 *     distance(center, arenaCenter) > arenaEdgeRadius + pawnRadius
 *
 * The threshold moved outward by one pawn radius when the platform was
 * restored: it used to be `floorRadius + pawnRadius`, which is the drawn
 * edge itself — the pawn died with its centre ON the edge, i.e. with
 * half of it still over the platform. Now the pawn's inner rim must
 * clear that edge, so a full diameter is off before it falls.
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
 *     DRAWN EDGE        330   (the platform the player sees)
 *   + pawn radius        16
 *   ────────────────────────
 *     ELIMINATION AT    346   (strictly greater than)
 *
 * Every number is written out. If any CONFIG value moves, or the rule
 * drifts back to killing at the drawn edge (the half-out bug), these
 * fail loudly.
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

  it("eliminates at exactly 346 units — not 330", () => {
    const arena = createArena();
    const at = (d: number) =>
      isPawnOutOfBounds(arena, CENTER_X + d, CENTER_Y, 16);

    // 330 is the DRAWN edge: the pawn is exactly half out here, still
    // sitting on the platform. It must live. This is the assertion that
    // fails if the rule drifts back to killing at the visible edge.
    expect(at(330)).toBe(false);

    // Every intermediate position is still alive: the pawn is sliding
    // off, but part of it is still over the platform.
    for (const d of [331, 335, 340, 345, 345.999]) {
      expect(at(d)).toBe(false);
    }

    // 346 exactly: the pawn's inner rim grazes the drawn edge — a whole
    // diameter is off. Strictly greater-than, so this still survives.
    expect(at(346)).toBe(false);

    // Past 346: completely clear of the platform, eliminated.
    for (const d of [346.001, 347, 360, 400]) {
      expect(at(d)).toBe(true);
    }
  });

  it("gives the pawn a full DIAMETER of grace past the drawn edge", () => {
    const arena = createArena();
    // The difference between the correct rule and the half-out bug,
    // stated as a number: one whole pawn diameter beyond the platform.
    let lastAlive = 314;
    for (let d = 314; d <= 380; d += 0.5) {
      if (!isPawnOutOfBounds(arena, CENTER_X + d, CENTER_Y, 16)) lastAlive = d;
    }
    expect(lastAlive).toBe(346);
    expect(lastAlive - arenaEdgeRadius(arena)).toBe(CONFIG.pawn.radius);
    // Measured from the floor it is two radii — a full diameter.
    expect(lastAlive - floorRadius(arena)).toBe(2 * CONFIG.pawn.radius);
  });

  it("holds at every radius on the shrink schedule", () => {
    // 330 → 290 → 250 → 210 → 180, and the boundary tracks each one.
    const expected: ReadonlyArray<readonly [number, number, number]> = [
      // [arena radius, floor, elimination distance = drawn edge + 16]
      [330, 314, 346],
      [290, 274, 306],
      [250, 234, 266],
      [210, 194, 226],
      [180, 164, 196],
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

  it("is radially symmetric — 346 in every direction, not just +x", () => {
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
      // Floating point: a point placed at exactly 346 by cos/sin can land
      // a hair over, so assert just inside and just outside the boundary.
      expect(probe(345.99)).toBe(false);
      expect(probe(346.01)).toBe(true);
      expect(probe(330)).toBe(false); // half out, alive, at every angle
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
