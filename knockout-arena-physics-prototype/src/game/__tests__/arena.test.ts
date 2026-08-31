import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  createArena,
  floorRadius,
  isPawnOutOfBounds,
  spawnPositionAtAngle,
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

  it("is true once the pawn has completely left the floor", () => {
    const dist = floorRadius(arena) + PAWN_R + 0.001;
    expect(isPawnOutOfBounds(arena, centerX + dist, centerY, PAWN_R)).toBe(true);
  });

  it("uses the pawn radius consistently", () => {
    const dist = floorRadius(arena) + 10;
    // A small pawn is already fully out at this distance; a big pawn still
    // touches the floor (its center must travel farther to clear the edge).
    expect(isPawnOutOfBounds(arena, centerX, centerY + dist, 8)).toBe(true);
    expect(isPawnOutOfBounds(arena, centerX, centerY + dist, 24)).toBe(false);
  });

  it("treats every direction equally (radial symmetry)", () => {
    const dist = floorRadius(arena) + PAWN_R + 5;
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

describe("spawnPositionAtAngle", () => {
  const arena = createArena();

  it("spawns at the top edge for angle -π/2 (the phase-1 spawn)", () => {
    const [x, y] = spawnPositionAtAngle(arena, -Math.PI / 2);
    expect(x).toBeCloseTo(CONFIG.arena.centerX, 9);
    expect(y).toBeCloseTo(110, 9); // centerY - (floor - pawnR - 8)
  });

  it("spawns at the right edge for angle 0", () => {
    const [x, y] = spawnPositionAtAngle(arena, 0);
    expect(x).toBeCloseTo(690, 9); // centerX + 240
    expect(y).toBeCloseTo(CONFIG.arena.centerY, 9);
  });

  it("keeps every spawn inside the floor", () => {
    const expected = floorRadius(arena) - PAWN_R - 8;
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const [x, y] = spawnPositionAtAngle(arena, angle);
      const dist = Math.hypot(x - arena.centerX, y - arena.centerY);
      expect(dist).toBeCloseTo(expected, 9);
      expect(isPawnOutOfBounds(arena, x, y, PAWN_R)).toBe(false);
    }
  });
});
