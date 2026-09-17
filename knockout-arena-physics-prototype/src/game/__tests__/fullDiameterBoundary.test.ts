import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  arenaEdgeRadius,
  createArena,
  floorRadius,
  isPawnDroppedByShrink,
  isPawnOutOfBounds,
} from "../arena";
import { createPhysicsWorld } from "../physics";

/**
 * FOLLOW-UP TO TASK 30 — two boundaries, on purpose.
 *
 * The reported bug: "a pawn dies when it has left the arena by only half
 * its diameter." True, and visible — the pawn vanished while its disc
 * still overlapped the platform. The old rule killed at
 * `floorRadius + pawnRadius`, which is exactly arenaEdgeRadius, the
 * circle the renderer draws. Centre on the rim = 50% still on the floor.
 *
 * THE ROUND RULE (isPawnOutOfBounds) now gives a full diameter of grace:
 *
 *     death at  arenaEdgeRadius + pawnRadius   (330 + 16 = 346)
 *
 * so the pawn's inner rim must clear the drawn edge before it falls.
 * Between 330 and 346 the pawn hangs over the void and lives.
 *
 * THE SHRINK RULE (isPawnDroppedByShrink) is deliberately stricter:
 *
 *     death at  arenaEdgeRadius                (the new drawn edge)
 *
 * Why the two differ: teetering on the rim after being SHOVED is a
 * survivable accident, but a shrink pulls the floor out from under
 * everyone at once — a pawn whose centre is past the new edge has
 * nothing underneath it and falls. Without the split the shrink would
 * stop killing anybody at all (see the regression test below), which
 * would quietly disable the mechanic that closes the arena.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const PAWN_R = CONFIG.pawn.radius; // 16
const SCHEDULE = [330, 290, 250, 210, 180] as const;

describe("the round rule: a full diameter of grace", () => {
  it("survives with the centre exactly on the drawn edge (half out)", () => {
    const arena = createArena();
    const edge = arenaEdgeRadius(arena);
    expect(edge).toBe(330);
    // This is the exact position the bug report described.
    expect(isPawnOutOfBounds(arena, CX + edge, CY, PAWN_R)).toBe(false);
  });

  it("dies only once the WHOLE diameter has cleared the platform", () => {
    const arena = createArena();
    const edge = arenaEdgeRadius(arena);

    // Sweep outward and record how much of the pawn is off the platform
    // at the moment it dies. It must be a full diameter, not a radius.
    let firstDead = Infinity;
    for (let d = edge - 5; d <= edge + 40; d += 0.25) {
      if (isPawnOutOfBounds(arena, CX + d, CY, PAWN_R)) {
        firstDead = d;
        break;
      }
    }
    const overhangAtDeath = firstDead - edge + PAWN_R;
    expect(overhangAtDeath).toBeGreaterThan(2 * PAWN_R); // > one diameter
    expect(overhangAtDeath).toBeLessThanOrEqual(2 * PAWN_R + 0.25);
  });

  it("keeps a 16-unit survival band beyond the visible edge", () => {
    const arena = createArena();
    const edge = arenaEdgeRadius(arena);
    for (const d of [edge, edge + 1, edge + 8, edge + 15.9, edge + PAWN_R]) {
      expect(isPawnOutOfBounds(arena, CX + d, CY, PAWN_R)).toBe(false);
    }
    for (const d of [edge + PAWN_R + 0.001, edge + PAWN_R + 1, edge + 100]) {
      expect(isPawnOutOfBounds(arena, CX + d, CY, PAWN_R)).toBe(true);
    }
  });

  it("scales the grace with the PAWN's radius, not a constant", () => {
    const arena = createArena();
    const edge = arenaEdgeRadius(arena);
    for (const r of [4, 8, 16, 24]) {
      expect(isPawnOutOfBounds(arena, CX + edge + r, CY, r)).toBe(false);
      expect(isPawnOutOfBounds(arena, CX + edge + r + 0.001, CY, r)).toBe(true);
    }
  });

  it("holds at every radius on the shrink schedule", () => {
    for (const radius of SCHEDULE) {
      const arena = createArena(radius);
      const lethal = arenaEdgeRadius(arena) + PAWN_R;
      expect(lethal).toBe(radius + PAWN_R); // edge == arena.radius
      expect(isPawnOutOfBounds(arena, CX + lethal, CY, PAWN_R)).toBe(false);
      expect(isPawnOutOfBounds(arena, CX + lethal + 0.001, CY, PAWN_R)).toBe(
        true
      );
    }
  });

  it("is radially symmetric", () => {
    const arena = createArena();
    const lethal = arenaEdgeRadius(arena) + PAWN_R;
    for (let i = 0; i < 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      const at = (d: number) =>
        isPawnOutOfBounds(
          arena,
          CX + Math.cos(a) * d,
          CY + Math.sin(a) * d,
          PAWN_R
        );
      expect(at(lethal - 0.01)).toBe(false);
      expect(at(lethal + 0.01)).toBe(true);
    }
  });
});

describe("settling never teleports the pawn", () => {
  it("a pawn that stops in the grace band is left exactly there", () => {
    // The grace band only means something if the pawn is allowed to
    // REMAIN in it. settleOnFloor used to drag anything past
    // floorRadius - pawnRadius - 1 (297) back to that circle, a jump of
    // up to 49 units that deleted the whole "teetering on the brink"
    // moment the round rule exists to allow.
    const arena = createArena();
    const edge = arenaEdgeRadius(arena);
    const world = createPhysicsWorld();
    for (const d of [297, 314, edge, edge + PAWN_R - 0.5]) {
      const body = world.createPawnBody("x" + d, CX + d, CY, PAWN_R);
      world.settleOnFloor(body, PAWN_R);
      const p = world.position(body);
      expect(Math.hypot(p.x - CX, p.y - CY)).toBeCloseTo(d, 9);
      // Still alive out there — settling did not change its fate.
      expect(isPawnOutOfBounds(arena, p.x, p.y, PAWN_R)).toBe(false);
    }
    world.destroy();
  });

  it("the shrink still catches a pawn that settled out on the brink", () => {
    // Consequence worth pinning: because pawns now rest FURTHER out, the
    // next shrink catches them at least as readily as before. A pawn
    // resting on the 330 edge is well outside the 290 platform.
    const world = createPhysicsWorld();
    const edge = arenaEdgeRadius(createArena(330));
    const body = world.createPawnBody("brink", CX + edge, CY, PAWN_R);
    world.settleOnFloor(body, PAWN_R);
    const p = world.position(body);
    expect(isPawnDroppedByShrink(createArena(290), p.x, p.y)).toBe(true);
    world.destroy();
  });
});

describe("the shrink rule: no floor left underneath", () => {
  it("kills a pawn whose centre is past the new edge", () => {
    const arena = createArena(290);
    const edge = arenaEdgeRadius(arena);
    expect(isPawnDroppedByShrink(arena, CX + edge + 0.001, CY)).toBe(true);
  });

  it("spares a pawn still straddling the new edge", () => {
    // Half over the void but centred on floor: the shrink comment
    // promises straddlers survive, and they do.
    const arena = createArena(290);
    const edge = arenaEdgeRadius(arena);
    expect(isPawnDroppedByShrink(arena, CX + edge - 0.001, CY)).toBe(false);
    expect(isPawnDroppedByShrink(arena, CX + edge - 1, CY)).toBe(false);
    expect(isPawnDroppedByShrink(arena, CX, CY)).toBe(false);
  });

  it("REGRESSION: the shrink still eliminates settled rim-huggers", () => {
    // A pawn that settled against the old rim rests at
    // floorRadius - pawnRadius - 1 (physics.settleOnFloor). After the
    // arena shrinks by one step it must be gone.
    //
    // This is the test that fails if the shrink is ever switched back to
    // the generous round rule: 297 is well inside 290's grace band (306),
    // so the pawn would survive and the arena would stop closing.
    const steps: ReadonlyArray<readonly [number, number]> = [
      [330, 290],
      [290, 250],
      [250, 210],
    ];
    for (const [from, to] of steps) {
      const settled = floorRadius(createArena(from)) - PAWN_R - 1;
      const smaller = createArena(to);
      expect(isPawnDroppedByShrink(smaller, CX + settled, CY)).toBe(true);
      // …and the generous round rule would NOT have caught it — proof
      // the two rules are doing different jobs.
      expect(isPawnOutOfBounds(smaller, CX + settled, CY, PAWN_R)).toBe(false);
    }
  });

  it("is stricter than the round rule at every radius", () => {
    for (const radius of SCHEDULE) {
      const arena = createArena(radius);
      const edge = arenaEdgeRadius(arena);
      // A point in the grace band: dropped by a shrink, safe in a round.
      const inBand = edge + PAWN_R / 2;
      expect(isPawnDroppedByShrink(arena, CX + inBand, CY)).toBe(true);
      expect(isPawnOutOfBounds(arena, CX + inBand, CY, PAWN_R)).toBe(false);
    }
  });

  it("ignores pawn size — it is a pure centre-over-floor question", () => {
    const arena = createArena();
    const edge = arenaEdgeRadius(arena);
    // Same verdict regardless of how big the pawn is: what matters is
    // whether there is floor under its centre.
    expect(isPawnDroppedByShrink(arena, CX + edge + 1, CY)).toBe(true);
    expect(isPawnDroppedByShrink(arena, CX + edge - 1, CY)).toBe(false);
  });
});
