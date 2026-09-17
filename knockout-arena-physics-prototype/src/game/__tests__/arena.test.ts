import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  arenaEdgeRadius,
  createArena,
  floorRadius,
  isPawnOutOfBounds,
  spawnPositionAtAngle,
  spawnRingRadius,
} from "../arena";

const PAWN_R = CONFIG.pawn.radius; // 16

describe("createArena", () => {
  it("derives the arena from CONFIG", () => {
    const arena = createArena();
    expect(arena.centerX).toBe(CONFIG.arena.centerX);
    expect(arena.centerY).toBe(CONFIG.arena.centerY);
    expect(arena.radius).toBe(CONFIG.arena.radius);
    expect(arena.wallThickness).toBe(CONFIG.arena.wallThickness);
  });
});

describe("floorRadius", () => {
  it("is the outer radius minus the wall thickness", () => {
    expect(floorRadius(createArena())).toBe(
      CONFIG.arena.radius - CONFIG.arena.wallThickness
    );
  });
});

describe("isPawnOutOfBounds (geometric elimination rule)", () => {
  const arena = createArena();
  const { centerX, centerY } = arena;

  it("is false at the arena center", () => {
    expect(isPawnOutOfBounds(arena, centerX, centerY, PAWN_R)).toBe(false);
  });

  it("is false while any part of the pawn still touches the floor", () => {
    // Just barely inside the boundary: dist = floor + radius - ε
    const dist = floorRadius(arena) + PAWN_R - 0.001;
    expect(isPawnOutOfBounds(arena, centerX + dist, centerY, PAWN_R)).toBe(false);
  });

  it("is false exactly at the boundary (strictly greater-than rule)", () => {
    const dist = floorRadius(arena) + PAWN_R;
    expect(isPawnOutOfBounds(arena, centerX + dist, centerY, PAWN_R)).toBe(false);
  });

  it("is true once the pawn has completely left the platform", () => {
    // A whole diameter past the drawn edge (see arenaEdgeRadius).
    const dist = arenaEdgeRadius(arena) + PAWN_R + 0.001;
    expect(isPawnOutOfBounds(arena, centerX + dist, centerY, PAWN_R)).toBe(true);
  });

  it("still alive when only HALF the pawn is off the platform", () => {
    // The centre sits exactly on the visible edge: half the disc hangs
    // over the void, and that survives on purpose.
    const dist = arenaEdgeRadius(arena);
    expect(isPawnOutOfBounds(arena, centerX + dist, centerY, PAWN_R)).toBe(
      false
    );
  });

  it("uses the pawn radius consistently", () => {
    // Just past the drawn edge: a SMALL pawn has already cleared it by
    // its own diameter, a BIG one has not — its centre must travel
    // farther before the whole disc is off.
    const dist = arenaEdgeRadius(arena) + 10;
    expect(isPawnOutOfBounds(arena, centerX, centerY + dist, 8)).toBe(true);
    expect(isPawnOutOfBounds(arena, centerX, centerY + dist, 24)).toBe(false);
  });

  it("treats every direction equally (radial symmetry)", () => {
    const dist = arenaEdgeRadius(arena) + PAWN_R + 5;
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 2.5]) {
      const x = centerX + Math.cos(angle) * dist;
      const y = centerY + Math.sin(angle) * dist;
      expect(isPawnOutOfBounds(arena, x, y, PAWN_R)).toBe(true);
    }
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 2.5]) {
      const x = centerX + Math.cos(angle) * (dist - PAWN_R - 10);
      const y = centerY + Math.sin(angle) * (dist - PAWN_R - 10);
      expect(isPawnOutOfBounds(arena, x, y, PAWN_R)).toBe(false);
    }
  });
});

describe("arena size (source of truth)", () => {
  it("pins the enlarged radius: 330 outer, 314 floor, centered in the world", () => {
    // CONFIG.arena is the single source of truth: spawns, the logical
    // elimination boundary, resting projection and rendering all derive
    // from it (nothing hard-codes a radius anywhere else).
    expect(CONFIG.arena.radius).toBe(330);
    expect(CONFIG.arena.centerX).toBe(450);
    expect(CONFIG.arena.centerY).toBe(350);
    expect(floorRadius(createArena())).toBe(314); // 330 - wallThickness 16
    // The whole arena fits inside the world frame with room to spare.
    expect(CONFIG.arena.radius).toBeLessThan(
      Math.min(CONFIG.world.width / 2, CONFIG.world.height / 2)
    );
  });
});

describe("spawnPositionAtAngle", () => {
  const arena = createArena();

  /** floor − pawnRadius − spawnMargin: the single spawn-ring formula. */
  const RING = spawnRingRadius(arena);

  it("spawns at the top edge for angle -π/2", () => {
    const [x, y] = spawnPositionAtAngle(arena, -Math.PI / 2);
    expect(x).toBeCloseTo(CONFIG.arena.centerX, 9);
    expect(y).toBeCloseTo(CONFIG.arena.centerY - RING, 9);
  });

  it("spawns at the right edge for angle 0", () => {
    const [x, y] = spawnPositionAtAngle(arena, 0);
    expect(x).toBeCloseTo(CONFIG.arena.centerX + RING, 9);
    expect(y).toBeCloseTo(CONFIG.arena.centerY, 9);
  });

  it("keeps every spawn inside the floor", () => {
    const expected = RING;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const [x, y] = spawnPositionAtAngle(arena, angle);
      const dist = Math.hypot(x - arena.centerX, y - arena.centerY);
      expect(dist).toBeCloseTo(expected, 9);
      expect(isPawnOutOfBounds(arena, x, y, PAWN_R)).toBe(false);
    }
  });
});
