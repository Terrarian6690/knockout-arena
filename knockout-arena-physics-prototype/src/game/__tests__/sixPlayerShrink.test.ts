import { describe, expect, it } from "vitest";
import {
  CONFIG,
  createArena,
  createGame,
  floorRadius,
  spawnPositionForSlot,
  spawnRingRadius,
} from "../index";

/**
 * SIX PLAYERS vs THE SHRINKING ARENA (Task 8, item 6).
 *
 * Two separate questions, both verification rather than redesign:
 *
 *   1. do the six FIXED spawn slots keep clearance as the arena steps
 *      down 330 → 290 → 250 → 210 → 180? (Task 7 fixed the first step;
 *      this walks the whole schedule.)
 *   2. can a player who lingers near the rim still be eliminated BY the
 *      shrink — and are players never re-projected just because the
 *      floor moved?
 */

const SCHEDULE = [330, 290, 250, 210, 180];
const MAX = CONFIG.match.maxPlayers;
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

const dist = (p: { x: number; y: number }) => Math.hypot(p.x - CX, p.y - CY);

describe("six spawn slots keep clearance across the whole schedule", () => {
  it("matches the documented schedule", () => {
    expect(CONFIG.arena.radius).toBe(330);
    expect(CONFIG.arena.shrink.amount).toBe(40);
    expect(CONFIG.arena.shrink.minRadius).toBe(180);
    const steps: number[] = [CONFIG.arena.radius];
    let r: number = CONFIG.arena.radius;
    while (r > CONFIG.arena.shrink.minRadius) {
      r = Math.max(CONFIG.arena.shrink.minRadius, r - CONFIG.arena.shrink.amount);
      steps.push(r);
    }
    expect(steps).toEqual(SCHEDULE);
  });

  it("keeps all six spawns strictly inside the floor at every radius", () => {
    for (const radius of SCHEDULE) {
      const arena = createArena(radius);
      const floor = floorRadius(arena);
      for (let slot = 0; slot < MAX; slot++) {
        const [x, y] = spawnPositionForSlot(arena, slot);
        const d = Math.hypot(x - CX, y - CY);
        // The entire pawn disc is inside the floor…
        expect(d + CONFIG.pawn.radius).toBeLessThanOrEqual(floor);
        // …with the configured margin to spare, at every angle.
        expect(d).toBeCloseTo(spawnRingRadius(arena), 9);
      }
    }
  });

  it("survives every shrink step with real clearance, not float luck", () => {
    // The elimination rule is distance > floor + pawnRadius. A spawn ring
    // sitting exactly on that threshold survives only by strict `>` and
    // rounds the wrong way at off-axis angles (the Task 7 bug). Require a
    // genuine margin at EVERY radius and EVERY slot.
    for (const radius of SCHEDULE) {
      const arena = createArena(radius);
      const threshold = floorRadius(arena) + CONFIG.pawn.radius;
      for (let slot = 0; slot < MAX; slot++) {
        const [x, y] = spawnPositionForSlot(arena, slot);
        expect(threshold - Math.hypot(x - CX, y - CY)).toBeGreaterThanOrEqual(
          CONFIG.arena.spawnMargin
        );
      }
    }
  });

  it("never lets two of the six touch, however small the arena gets", () => {
    for (const radius of SCHEDULE) {
      const arena = createArena(radius);
      const pts = Array.from({ length: MAX }, (_, i) => spawnPositionForSlot(arena, i));
      for (let a = 0; a < MAX; a++) {
        for (let b = a + 1; b < MAX; b++) {
          const gap = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
          expect(gap).toBeGreaterThan(CONFIG.pawn.radius * 2);
        }
      }
    }
  });
});

describe("the shrinking boundary still eliminates", () => {
  /** A six-player game with every pawn left at its spawn. */
  function sixPlayerGame() {
    return createGame({
      players: Array.from({ length: MAX }, (_, i) => ({
        id: `p${i}`,
        name: `Player ${i + 1}`,
      })),
    });
  }

  it("eliminates a rim-hugging pawn when the floor retreats past it", () => {
    // A pawn parked between the NEXT floor and the current one: safe at
    // 330, doomed the moment the arena steps to 290. Restored through
    // deserialize so the engine really owns the position.
    const nowSafe = floorRadius(createArena(SCHEDULE[0])) + CONFIG.pawn.radius - 2;
    const doomedAt = floorRadius(createArena(SCHEDULE[1])) + CONFIG.pawn.radius;
    expect(nowSafe).toBeGreaterThan(doomedAt); // the band exists

    const restored = sixPlayerGame();
    const state = restored.getState();
    state.pawns[0].position = { x: CX + nowSafe, y: CY };
    restored.loadState(state); // the real restore path

    // Alive at the initial radius, and actually AT the rim.
    expect(dist(restored.getState().pawns[0].position)).toBeCloseTo(nowSafe, 6);
    expect(restored.getState().pawns[0].eliminated).toBe(false);

    // …and eliminated by the boundary once the shrink lands.
    for (let round = 0; round < CONFIG.arena.shrink.everyRounds; round++) {
      restored.applyCommand({ type: "resolveRound" });
      let guard = 0;
      while (restored.getState().phase === "moving" && guard++ < 5_000) {
        restored.update(1000 / 60);
      }
    }
    const after = restored.getState();
    expect(after.arena!.radius).toBe(SCHEDULE[1]);
    expect(after.pawns[0].eliminated).toBe(true);
    // The shrink took ONLY the rim-hugger; the five on the spawn ring live.
    expect(after.pawns.filter((p) => p.eliminated)).toHaveLength(1);
  });

  it("does NOT move anyone merely because the arena shrank", () => {
    const game = sixPlayerGame();
    const before = game.getState().pawns.map((p) => ({ ...p.position }));
    expect(game.getState().arena!.radius).toBe(CONFIG.arena.radius);

    // Drive REAL empty rounds until the authoritative shrink lands.
    for (let round = 0; round < CONFIG.arena.shrink.everyRounds; round++) {
      game.applyCommand({ type: "resolveRound" });
      let guard = 0;
      while (game.getState().phase === "moving" && guard++ < 5_000) {
        game.update(1000 / 60);
      }
    }
    // The arena really did shrink…
    expect(game.getState().arena!.radius).toBe(SCHEDULE[1]);

    // …and every pawn is exactly where it was: no re-projection onto the
    // smaller floor, no nudging inward.
    const after = game.getState().pawns.map((p) => ({ ...p.position }));
    expect(after).toEqual(before);
    // Nobody was eliminated by the shrink either — the spawn ring has
    // clearance (this is the Task 7 regression, at engine level).
    expect(game.getState().pawns.every((p) => !p.eliminated)).toBe(true);
  });

  it("keeps all six alive at the START of a match (nobody spawns out)", () => {
    const game = sixPlayerGame();
    const state = game.getState();
    expect(state.pawns).toHaveLength(MAX);
    expect(state.pawns.every((p) => !p.eliminated)).toBe(true);
    const threshold =
      floorRadius(createArena(state.arena!.radius)) + CONFIG.pawn.radius;
    for (const pawn of state.pawns) {
      expect(dist(pawn.position)).toBeLessThan(threshold);
    }
  });
});
