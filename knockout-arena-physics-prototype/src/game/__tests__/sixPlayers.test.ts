import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  createArena,
  floorRadius,
  isPawnOutOfBounds,
  spawnPositionForSlot,
  spawnRingRadius,
  spawnSlotAngle,
} from "../arena";
import { createGame, type GameHandle } from "../game";
import { projectSnapshot } from "../project";
import { PLAYER_COLORS, PLAYER_STROKES, playerColor, playerStroke } from "../player";
import { deserializeGameState, serializeGameState } from "../state";

/**
 * SIX-PLAYER capacity — engine half (Task 7).
 *
 * The engine was never written against a fixed roster size, so these
 * tests pin the things that genuinely change at six: the fixed spawn
 * ring, six distinguishable identities, six independent simultaneous
 * choices, six independent eliminations, and a winner among six.
 *
 * The SERVER half (rooms, seats, rejection, reconnect) lives in
 * src/server/__tests__/sixPlayers.test.ts.
 */

const DT = CONFIG.simulation.fixedTimestepMs;
const MAX = CONFIG.match.maxPlayers;
const ARENA = createArena();
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const PAWN_R = CONFIG.pawn.radius;

function specs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i + 1}`,
  }));
}

function distFromCenter(p: { x: number; y: number }): number {
  return Math.hypot(p.x - CX, p.y - CY);
}

/** Resolve the round and run the simulation until it settles. */
function playRound(g: GameHandle): void {
  if (g.getState().phase !== "moving") {
    g.applyCommand({ type: "resolveRound" });
  }
  let guard = 0;
  while (g.getState().phase === "moving" && guard++ < 5_000) g.update(DT);
}

/** Aim a pawn straight outward and confirm: a self-elimination. */
function chooseSelfOut(g: GameHandle, id: string): void {
  const me = g.getState().pawns.find((p) => p.id === id)!;
  const dx = me.position.x - CX || 1;
  const dy = me.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  g.applyCommand({
    type: "aim",
    playerId: id,
    x: CX + (dx / len) * 900,
    y: CY + (dy / len) * 900,
  });
  g.applyCommand({ type: "setPower", playerId: id, power: 5 });
  g.applyCommand({ type: "confirmLaunch", playerId: id });
}

describe("capacity is one constant", () => {
  it("is six, and the spawn ring is built from it", () => {
    expect(CONFIG.match.maxPlayers).toBe(6);
    // Six slots exist because capacity says six — not a second constant.
    const angles = Array.from({ length: MAX }, (_, i) => spawnSlotAngle(i));
    expect(angles).toHaveLength(6);
  });
});

describe("the six fixed spawn slots", () => {
  it("are six UNIQUE positions", () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(ARENA, slot);
      seen.add(`${x.toFixed(6)},${y.toFixed(6)}`);
    }
    expect(seen.size).toBe(MAX);
  });

  it("are EVENLY distributed: every slot 60° from its neighbours", () => {
    // Normalize to [0, 360) and sort: consecutive gaps must all be 60°.
    const degrees = Array.from({ length: MAX }, (_, i) => {
      const deg = (spawnSlotAngle(i) * 180) / Math.PI;
      return ((deg % 360) + 360) % 360;
    }).sort((a, b) => a - b);

    for (let i = 0; i < degrees.length; i++) {
      const next = degrees[(i + 1) % degrees.length];
      const gap = (((next - degrees[i]) % 360) + 360) % 360;
      expect(gap === 0 ? 360 : gap).toBeCloseTo(360 / MAX, 9);
    }
  });

  it("all sit on ONE ring at the same distance from the center", () => {
    const ring = spawnRingRadius(ARENA);
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(ARENA, slot);
      expect(distFromCenter({ x, y })).toBeCloseTo(ring, 9);
    }
  });

  it("fit safely INSIDE the arena — all six, with real clearance", () => {
    const floor = floorRadius(ARENA);
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(ARENA, slot);
      // Not merely "not out of bounds": the whole pawn is inside the
      // floor with the configured margin to spare.
      expect(isPawnOutOfBounds(ARENA, x, y, PAWN_R)).toBe(false);
      expect(distFromCenter({ x, y }) + PAWN_R).toBeLessThanOrEqual(floor);
      expect(floor - (distFromCenter({ x, y }) + PAWN_R)).toBeGreaterThanOrEqual(
        CONFIG.arena.spawnMargin - 1e-9
      );
    }
  });

  it("never overlap: adjacent pawns are far apart at spawn", () => {
    const points = Array.from({ length: MAX }, (_, i) =>
      spawnPositionForSlot(ARENA, i)
    );
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        const d = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]);
        expect(d).toBeGreaterThan(2 * PAWN_R);
      }
    }
  });

  it("survive the FIRST arena shrink (the ring is not on the boundary)", () => {
    // Regression: with the old 8-unit margin the ring sat exactly on the
    // post-shrink elimination boundary, so off-axis spawns were wiped
    // out by floating-point rounding the moment the arena first shrank.
    const shrunk = createArena(CONFIG.arena.radius - CONFIG.arena.shrink.amount);
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(ARENA, slot); // spawned on the FULL floor
      expect(isPawnOutOfBounds(shrunk, x, y, PAWN_R)).toBe(false);
    }
  });

  it("keep the first two seats diametrically opposed", () => {
    const [ax, ay] = spawnPositionForSlot(ARENA, 0);
    const [bx, by] = spawnPositionForSlot(ARENA, 1);
    expect(Math.hypot(bx - ax, by - ay)).toBeCloseTo(2 * spawnRingRadius(ARENA), 6);
  });

  it("follow the arena when it shrinks (one derivation, not a snapshot)", () => {
    const small = createArena(CONFIG.arena.shrink.minRadius);
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(small, slot);
      expect(distFromCenter({ x, y })).toBeCloseTo(spawnRingRadius(small), 9);
      expect(isPawnOutOfBounds(small, x, y, PAWN_R)).toBe(false);
    }
  });
});

describe("a six-player match", () => {
  it("seats all six pawns, each on its own slot", () => {
    const g = createGame({ players: specs(6) });
    const s = g.getState();
    expect(s.pawns).toHaveLength(6);
    expect(s.pawns.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    for (let i = 0; i < 6; i++) {
      const [x, y] = spawnPositionForSlot(ARENA, i);
      expect(s.pawns[i].position.x).toBeCloseTo(x, 9);
      expect(s.pawns[i].position.y).toBeCloseTo(y, 9);
      expect(s.pawns[i].eliminated).toBe(false);
    }
    g.destroy();
  });

  it.each([2, 3, 4, 5])(
    "leaves EMPTY spawn gaps with only %i players (slots stay fixed)",
    (n) => {
      const g = createGame({ players: specs(n) });
      const occupied = g.getState().pawns.map((p) => p.position);
      expect(occupied).toHaveLength(n);

      // Each present player is exactly on ITS OWN slot — the same place
      // it would occupy in a full six-player match.
      for (let i = 0; i < n; i++) {
        const [x, y] = spawnPositionForSlot(ARENA, i);
        expect(occupied[i].x).toBeCloseTo(x, 9);
        expect(occupied[i].y).toBeCloseTo(y, 9);
      }

      // …and the remaining slots are genuinely EMPTY: no pawn stands on
      // any of them.
      for (let slot = n; slot < MAX; slot++) {
        const [gx, gy] = spawnPositionForSlot(ARENA, slot);
        const occupiedHere = occupied.some(
          (p) => Math.hypot(p.x - gx, p.y - gy) < PAWN_R
        );
        expect(occupiedHere).toBe(false);
      }
      g.destroy();
    }
  );

  it("gives all six pawns distinguishable colors", () => {
    const g = createGame({ players: specs(6) });
    const s = g.getState();
    const colors = s.pawns.map((p) => playerColor(p.colorIndex));
    const strokes = s.pawns.map((p) => playerStroke(p.colorIndex));
    // Six seats, six DISTINCT palette entries — no wrap-around reuse.
    expect(new Set(colors).size).toBe(6);
    expect(new Set(strokes).size).toBe(6);
    expect(PLAYER_COLORS.length).toBeGreaterThanOrEqual(6);
    expect(PLAYER_STROKES.length).toBeGreaterThanOrEqual(6);
    expect(s.pawns.map((p) => p.colorIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    g.destroy();
  });
});

describe("six simultaneous rounds", () => {
  it("lets all six choose independently and resolves them TOGETHER", () => {
    const g = createGame({ players: specs(6) });
    const before = g.getState().pawns.map((p) => ({ ...p.position }));

    // Every player aims inward at their own power — six independent
    // choices, none of which resolves the round on its own.
    for (let i = 0; i < 6; i++) {
      g.applyCommand({ type: "aim", playerId: `p${i}`, x: CX, y: CY });
      g.applyCommand({ type: "setPower", playerId: `p${i}`, power: 1 + (i % 3) });
      if (i < 5) {
        g.applyCommand({ type: "confirmLaunch", playerId: `p${i}` });
        // Still aiming: the set is not complete until the sixth confirms.
        expect(g.getState().phase).toBe("aiming");
      }
    }
    // Nothing has moved while the round was still being decided.
    expect(g.getState().pawns.map((p) => p.position)).toEqual(before);

    // The sixth confirmation completes the set → one shared transition.
    g.applyCommand({ type: "confirmLaunch", playerId: "p5" });
    const moving = g.getState();
    expect(moving.phase).toBe("moving");
    // ALL SIX carry launch velocity already, before any physics step.
    for (const pawn of moving.pawns) {
      expect(Math.hypot(pawn.velocity.x, pawn.velocity.y)).toBeGreaterThan(0);
    }
    g.destroy();
  });

  it("moves only the confirmed players when the deadline resolves", () => {
    const g = createGame({ players: specs(6) });
    const before = g.getState().pawns.map((p) => ({ ...p.position }));

    // Only the even seats commit; the odd seats stay silent.
    for (const i of [0, 2, 4]) {
      g.applyCommand({ type: "aim", playerId: `p${i}`, x: CX, y: CY });
      g.applyCommand({ type: "setPower", playerId: `p${i}`, power: 1 });
      g.applyCommand({ type: "confirmLaunch", playerId: `p${i}` });
    }
    playRound(g); // the server's decision deadline

    const after = g.getState().pawns;
    for (const i of [0, 2, 4]) {
      expect(distFromCenter(after[i].position)).toBeLessThan(
        distFromCenter(before[i]) - 1
      );
    }
    // The silent seats did not move one unit.
    for (const i of [1, 3, 5]) {
      expect(after[i].position).toEqual(before[i]);
    }
    g.destroy();
  });

  it("keeps every player's aim PRIVATE until the round resolves", () => {
    const g = createGame({ players: specs(6) });
    for (let i = 0; i < 6; i++) {
      g.applyCommand({ type: "aim", playerId: `p${i}`, x: CX, y: CY });
      g.applyCommand({ type: "setPower", playerId: `p${i}`, power: 2 + (i % 2) });
    }

    // Each of the six viewers sees their OWN aim and nobody else's.
    for (let viewer = 0; viewer < 6; viewer++) {
      const view = projectSnapshot(g.getState(), `p${viewer}`);
      expect(view.localPawnId).toBe(`p${viewer}`);
      expect(view.isAiming).toBe(true);
      expect(view.aimDirection).not.toBeNull();
      expect(view.power).toBe(2 + (viewer % 2)); // own power only
      for (const pawn of view.pawns) {
        // No pawn exposes a launch during aiming — not even the viewer's.
        expect(pawn.launch).toBeNull();
      }
      // The projection carries no other player's aim/power field at all.
      const serialized = JSON.stringify(view.pawns);
      expect(serialized).not.toContain("aimDirection");
    }
    g.destroy();
  });

  it("reveals all six committed launches once the round resolves", () => {
    const g = createGame({ players: specs(6) });
    for (let i = 0; i < 6; i++) {
      g.applyCommand({ type: "aim", playerId: `p${i}`, x: CX, y: CY });
      g.applyCommand({ type: "setPower", playerId: `p${i}`, power: 2 });
      g.applyCommand({ type: "confirmLaunch", playerId: `p${i}` });
    }
    expect(g.getState().phase).toBe("moving");

    // Every viewer now sees every committed launch — public fact.
    for (let viewer = 0; viewer < 6; viewer++) {
      const view = projectSnapshot(g.getState(), `p${viewer}`);
      for (const pawn of view.pawns) {
        expect(pawn.launch).not.toBeNull();
        expect(pawn.launch!.power).toBe(2);
        expect(Math.hypot(pawn.launch!.direction.x, pawn.launch!.direction.y))
          .toBeCloseTo(1, 9);
      }
    }
    g.destroy();
  });
});

describe("elimination and winner with six players", () => {
  it("eliminates six players INDEPENDENTLY, one at a time", () => {
    const g = createGame({ players: specs(6) });
    const order = ["p0", "p1", "p2", "p3", "p4"];
    const eliminated: string[] = [];

    for (const id of order) {
      chooseSelfOut(g, id);
      playRound(g);
      eliminated.push(id);

      const s = g.getState();
      // Exactly the players who jumped are out; everyone else is alive.
      for (const pawn of s.pawns) {
        expect(pawn.eliminated).toBe(eliminated.includes(pawn.id));
      }
      if (s.phase === "finished") break;
    }

    const final = g.getState();
    expect(final.phase).toBe("finished");
    expect(final.pawns.filter((p) => !p.eliminated)).toHaveLength(1);
    g.destroy();
  });

  it("declares the last survivor of six the winner", () => {
    const g = createGame({ players: specs(6) });
    for (const id of ["p0", "p1", "p2", "p3", "p4"]) {
      chooseSelfOut(g, id);
      playRound(g);
    }
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p5");
    expect(s.pawns.find((p) => p.id === "p5")!.eliminated).toBe(false);
    g.destroy();
  });

  it("survives the serialization boundary with six pawns", () => {
    const g = createGame({ players: specs(6) });
    for (let i = 0; i < 6; i++) {
      g.applyCommand({ type: "aim", playerId: `p${i}`, x: CX, y: CY });
      g.applyCommand({ type: "setPower", playerId: `p${i}`, power: 3 });
    }
    const state = g.getState();
    const round = deserializeGameState(serializeGameState(state));
    expect(round).toEqual(state);
    expect(round.pawns).toHaveLength(6);
    g.destroy();
  });

  it("restores all six seats on reset (fresh capacity, full arena)", () => {
    const g = createGame({ players: specs(6) });
    for (const id of ["p0", "p1", "p2"]) {
      chooseSelfOut(g, id);
      playRound(g);
    }
    expect(g.getState().pawns.filter((p) => p.eliminated)).toHaveLength(3);

    g.applyCommand({ type: "reset" });
    const s = g.getState();
    expect(s.pawns).toHaveLength(6);
    expect(s.pawns.every((p) => !p.eliminated)).toBe(true);
    expect(s.winnerId).toBeNull();
    expect(s.arena).toEqual({
      radius: CONFIG.arena.radius,
      roundsSinceShrink: 0,
    });
    // Every pawn is back on its own fixed slot, on the full floor.
    for (let i = 0; i < 6; i++) {
      const [x, y] = spawnPositionForSlot(ARENA, i);
      expect(s.pawns[i].position.x).toBeCloseTo(x, 9);
      expect(s.pawns[i].position.y).toBeCloseTo(y, 9);
    }
    g.destroy();
  });
});
