import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  arenaFromSnapshot,
  arenaShrinkView,
  clampArenaRadius,
  createArena,
  floorRadius,
  spawnRingRadius,
  initialArenaRadius,
  isMinArenaRadius,
  isPawnOutOfBounds,
  minArenaRadius,
  shrinkDueAfterRound,
  shrunkArenaRadius,
} from "../arena";
import { createGame, type GameHandle } from "../game";
import { projectSnapshot } from "../project";
import {
  deserializeGameState,
  serializeGameState,
  validateGameState,
  type GameState,
  type PawnState,
} from "../state";
import { createPhysicsWorld } from "../physics";

/**
 * THE SHRINKING ARENA (Task 5).
 *
 * The arena starts at the configured radius and shrinks by a fixed amount
 * after every N COMPLETED rounds, down to a configured minimum — never
 * below it, never mid-round, never on a client's say-so. These tests pin
 * the whole contract:
 *
 *   - the schedule (initial size, exact trigger round, multiple cycles,
 *     the minimum, and the fact that the schedule keeps running
 *     harmlessly once the minimum is reached);
 *   - WHERE the shrink happens: between rounds only, with a resolving
 *     round never retroactively altered;
 *   - that the shrink moves the LOGICAL boundary and nothing else — no
 *     wall, no barrier, pawns still leave freely;
 *   - that a pawn left outside the new boundary is eliminated by the
 *     authoritative engine while one inside survives;
 *   - that the current radius + countdown state reach clients through
 *     the authoritative snapshot, including after a state transfer
 *     (reconnect / late snapshot delivery);
 *   - that a reset restores the initial radius AND the schedule.
 *
 * Everything is driven through the public engine API — no internals, no
 * clocks, no client-side counting.
 */

const DT = CONFIG.simulation.fixedTimestepMs;
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const PAWN_R = CONFIG.pawn.radius;
const INITIAL = CONFIG.arena.radius; // 330
const STEP = CONFIG.arena.shrink.amount; // 30
const EVERY = CONFIG.arena.shrink.everyRounds; // 3
const MIN = CONFIG.arena.shrink.minRadius; // 180

function specs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    colorIndex: i,
  }));
}

/** A pawn placed at an exact position, resting and unconfirmed. */
function pawnAt(
  id: string,
  x: number,
  y: number,
  overrides: Partial<PawnState> = {}
): PawnState {
  return {
    id,
    name: id.toUpperCase(),
    colorIndex: Number(id.slice(1)) || 0,
    radius: PAWN_R,
    spawnX: x,
    spawnY: y,
    eliminated: false,
    power: 3,
    aim: { active: false, direction: { x: 0, y: -1 } },
    confirmed: false,
    lastLaunch: null,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    ...overrides,
  };
}

/** A full match state, optionally with a crafted arena/schedule position. */
function matchState(
  pawns: PawnState[],
  opts: {
    phase?: GameState["phase"];
    radius?: number;
    roundsSinceShrink?: number;
  } = {}
): GameState {
  return {
    phase: opts.phase ?? "aiming",
    winnerId: null,
    round: { settleTicks: 0 },
    arena: {
      radius: opts.radius ?? INITIAL,
      roundsSinceShrink: opts.roundsSinceShrink ?? 0,
    },
    pawns,
  };
}

/** Run one complete round: everyone nudges gently inward and settles. */
function playRound(g: GameHandle): void {
  for (const p of g.getState().pawns) {
    if (p.eliminated) continue;
    // Aim at the center at the lowest power: a deliberately harmless
    // round, so the SCHEDULE is what changes the arena — never a launch.
    g.applyCommand({ type: "aim", playerId: p.id, x: CX, y: CY });
    g.applyCommand({ type: "setPower", playerId: p.id, power: 1 });
    g.applyCommand({ type: "confirmLaunch", playerId: p.id });
  }
  let guard = 0;
  while (g.getState().phase === "moving" && guard++ < 5000) g.update(DT);
}

/**
 * Complete a round in which NOBODY moves: the server resolves it with no
 * confirmations, so every pawn keeps its exact position. Isolates the
 * SCHEDULE from the physics — what changes can only be the shrink.
 */
function playEmptyRound(g: GameHandle): void {
  g.applyCommand({ type: "resolveRound" });
  let guard = 0;
  while (g.getState().phase === "moving" && guard++ < 5000) g.update(DT);
}

/** The authoritative radius of a live engine. */
function radiusOf(g: GameHandle): number {
  return g.getState().arena!.radius;
}

function distFromCenter(p: { x: number; y: number }): number {
  return Math.hypot(p.x - CX, p.y - CY);
}

// ──────────────────────────────────────────────────────────────────────────

describe("shrink schedule (pure arithmetic — the single source of truth)", () => {
  it("starts at the configured initial radius of 330", () => {
    expect(INITIAL).toBe(330);
    expect(initialArenaRadius()).toBe(330);
    expect(createArena().radius).toBe(330);
    expect(createGame().getState().arena!.radius).toBe(330);
  });

  it("defines exactly one minimum radius, below the initial one", () => {
    expect(minArenaRadius()).toBe(MIN);
    expect(MIN).toBeLessThan(INITIAL);
    expect(isMinArenaRadius(MIN)).toBe(true);
    expect(isMinArenaRadius(MIN + 1)).toBe(false);
  });

  it("fires only once the interval of completed rounds has elapsed", () => {
    for (let n = 0; n < EVERY; n++) {
      expect(shrinkDueAfterRound(n)).toBe(false);
    }
    expect(shrinkDueAfterRound(EVERY)).toBe(true);
  });

  it("steps down by the configured amount and clamps at the minimum", () => {
    expect(shrunkArenaRadius(INITIAL)).toBe(INITIAL - STEP);
    expect(shrunkArenaRadius(MIN + STEP)).toBe(MIN);
    expect(shrunkArenaRadius(MIN)).toBe(MIN); // never below
    expect(shrunkArenaRadius(MIN - 100)).toBe(MIN);
  });

  it("clamps any radius into the legal [min, initial] range", () => {
    expect(clampArenaRadius(999)).toBe(INITIAL);
    expect(clampArenaRadius(0)).toBe(MIN);
    expect(clampArenaRadius(Number.NaN)).toBe(INITIAL);
    expect(clampArenaRadius(240)).toBe(240);
  });

  it("derives the countdown view from state alone (and stops at the minimum)", () => {
    expect(arenaShrinkView(INITIAL, 0)).toEqual({
      roundsUntilShrink: EVERY,
      nextRadius: INITIAL - STEP,
      warning: false,
    });
    expect(arenaShrinkView(INITIAL, EVERY - 1)).toEqual({
      roundsUntilShrink: 1,
      nextRadius: INITIAL - STEP,
      warning: true, // the shrink lands when THIS round completes
    });
    // At the minimum there is no next shrink at all — and so no warning.
    expect(arenaShrinkView(MIN, EVERY - 1)).toEqual({
      roundsUntilShrink: null,
      nextRadius: null,
      warning: false,
    });
  });
});

describe("the arena shrinks after every N completed rounds", () => {
  it("does NOT shrink before the interval has completed", () => {
    const g = createGame({ players: specs(2) });
    expect(radiusOf(g)).toBe(INITIAL);
    for (let round = 1; round < EVERY; round++) {
      playRound(g);
      expect(radiusOf(g), `after round ${round}`).toBe(INITIAL);
    }
    g.destroy();
  });

  it("shrinks exactly ON the N-th completed round", () => {
    const g = createGame({ players: specs(2) });
    for (let round = 1; round < EVERY; round++) playRound(g);
    expect(radiusOf(g)).toBe(INITIAL);
    playRound(g); // the N-th
    expect(radiusOf(g)).toBe(INITIAL - STEP);
    g.destroy();
  });

  it("keeps shrinking over multiple cycles: 330 → 300 → 270 → 240", () => {
    const g = createGame({ players: specs(2) });
    const seen: number[] = [];
    for (let round = 1; round <= EVERY * 3; round++) {
      playRound(g);
      seen.push(radiusOf(g));
    }
    // One value per completed round: unchanged twice, then a step down.
    expect(seen).toEqual([
      INITIAL, INITIAL, INITIAL - STEP,
      INITIAL - STEP, INITIAL - STEP, INITIAL - STEP * 2,
      INITIAL - STEP * 2, INITIAL - STEP * 2, INITIAL - STEP * 3,
    ]);
    g.destroy();
  });

  it("never shrinks below the minimum, however long the match runs", () => {
    const g = createGame({ players: specs(2) });
    const shrinksToMin = Math.ceil((INITIAL - MIN) / STEP);
    for (let round = 1; round <= EVERY * (shrinksToMin + 4); round++) {
      playRound(g);
      expect(radiusOf(g)).toBeGreaterThanOrEqual(MIN);
    }
    expect(radiusOf(g)).toBe(MIN);
    g.destroy();
  });

  it("stops shrinking once the minimum is reached (further intervals are no-ops)", () => {
    const g = createGame({ players: specs(2) });
    // Start one interval away from the last shrink into the minimum.
    g.loadState(
      matchState([pawnAt("p0", CX - 40, CY), pawnAt("p1", CX + 40, CY)], {
        radius: MIN + STEP,
        roundsSinceShrink: EVERY - 1,
      })
    );
    playRound(g);
    expect(radiusOf(g)).toBe(MIN); // the last effective shrink
    for (let round = 0; round < EVERY * 2; round++) {
      playRound(g);
      expect(radiusOf(g)).toBe(MIN); // and it stays there
    }
    g.destroy();
  });

  it("keeps each match's arena independent (a shrink is per-match state)", () => {
    // The radius is state, not a module-level constant: one match
    // shrinking must never shrink another — or the config itself.
    const a = createGame({ players: specs(2) });
    for (let round = 1; round <= EVERY; round++) playEmptyRound(a);
    expect(radiusOf(a)).toBe(INITIAL - STEP);

    const b = createGame({ players: specs(2) });
    expect(radiusOf(b)).toBe(INITIAL);
    expect(createArena().radius).toBe(INITIAL);
    expect(CONFIG.arena.radius).toBe(INITIAL);
    // …and b's spawns were placed on the FULL floor.
    const spawn = b.getState().pawns[0];
    expect(Math.round(distFromCenter({ x: spawn.spawnX, y: spawn.spawnY }))).toBe(
      Math.round(spawnRingRadius(createArena()))
    );
    a.destroy();
    b.destroy();
  });

  it("counts the schedule per COMPLETED round, not per tick or per command", () => {
    const g = createGame({ players: specs(2) });
    // Lots of aiming activity inside ONE round must not advance anything.
    for (let i = 0; i < 20; i++) {
      g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + i });
      g.applyCommand({ type: "setPower", playerId: "p0", power: 1 });
    }
    for (let i = 0; i < 100; i++) g.update(DT); // ticks during aiming
    expect(g.getState().arena!.roundsSinceShrink).toBe(0);
    expect(radiusOf(g)).toBe(INITIAL);
    playRound(g);
    expect(g.getState().arena!.roundsSinceShrink).toBe(1);
    g.destroy();
  });
});

describe("shrinking happens BETWEEN rounds, never during one", () => {
  it("keeps the radius fixed for every tick of a resolving round", () => {
    const g = createGame({ players: specs(2) });
    for (let round = 1; round < EVERY; round++) playRound(g);
    expect(radiusOf(g)).toBe(INITIAL);

    // The round whose completion triggers the shrink: confirm, then watch
    // every single tick of the movement phase.
    for (const id of ["p0", "p1"]) {
      g.applyCommand({ type: "aim", playerId: id, x: CX, y: CY });
      g.applyCommand({ type: "setPower", playerId: id, power: 1 });
      g.applyCommand({ type: "confirmLaunch", playerId: id });
    }
    expect(g.getState().phase).toBe("moving");
    let ticks = 0;
    while (g.getState().phase === "moving" && ticks++ < 5000) {
      expect(radiusOf(g), `tick ${ticks}`).toBe(INITIAL); // never mid-round
      g.update(DT);
    }
    // …and the moment the round ended, the shrink is there.
    expect(g.getState().phase).not.toBe("moving");
    expect(radiusOf(g)).toBe(INITIAL - STEP);
    g.destroy();
  });

  it("does not retroactively alter the resolved round's movement", () => {
    const g = createGame({ players: specs(2) });
    for (let round = 1; round < EVERY; round++) playRound(g);

    // Pawns resting comfortably inside the SHRUNKEN arena, in a round
    // where nothing moves: anything that differs afterwards could only
    // have been done by the shrink itself.
    g.loadState(
      matchState([pawnAt("p0", CX - 90, CY), pawnAt("p1", CX + 90, CY)], {
        roundsSinceShrink: EVERY - 1,
      })
    );
    const before = g.getState().pawns.map((p) => ({ ...p.position }));

    playEmptyRound(g);

    expect(radiusOf(g)).toBe(INITIAL - STEP); // the shrink did happen
    const after = g.getState().pawns.map((p) => ({ ...p.position }));
    // Same positions: shrinking judges the round's outcome, it does not
    // rewind, re-simulate or teleport anyone who is still inside.
    for (let i = 0; i < before.length; i++) {
      expect(after[i].x).toBeCloseTo(before[i].x, 6);
      expect(after[i].y).toBeCloseTo(before[i].y, 6);
    }
    g.destroy();
  });
});

describe("the shrink moves the LOGICAL boundary (no physical wall)", () => {
  it("eliminates a pawn left outside the new boundary", () => {
    const g = createGame({ players: specs(3) });
    // p1 hugs the rim — exactly where a settled pawn rests against the
    // CURRENT edge: inside today's boundary, outside the next one. This
    // is the case the shrink exists for.
    const doomed = floorRadius(createArena(INITIAL)) - PAWN_R - 1; // 297
    const safe = floorRadius(createArena(MIN)) - 40; // deep inside forever
    g.loadState(
      matchState(
        [
          pawnAt("p0", CX, CY - safe),
          pawnAt("p1", CX, CY + doomed),
          pawnAt("p2", CX + 20, CY),
        ],
        { roundsSinceShrink: EVERY - 1 }
      )
    );
    // Sanity: everyone is alive and inside BEFORE the shrink — p1
    // included, by the very same rule that will catch it.
    expect(g.getState().pawns.map((p) => p.eliminated)).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      isPawnOutOfBounds(createArena(INITIAL), CX, CY + doomed, PAWN_R)
    ).toBe(false);

    playEmptyRound(g); // nobody moves: only the arena changes

    const s = g.getState();
    expect(s.arena!.radius).toBe(INITIAL - STEP);
    const p1 = s.pawns.find((p) => p.id === "p1")!;
    expect(p1.eliminated).toBe(true); // the smaller arena caught it
    // …and it is genuinely outside the NEW boundary, by the ordinary rule.
    expect(
      isPawnOutOfBounds(
        createArena(s.arena!.radius),
        p1.position.x,
        p1.position.y,
        p1.radius
      )
    ).toBe(true);
    g.destroy();
  });

  it("leaves a pawn inside the new boundary alive", () => {
    const g = createGame({ players: specs(2) });
    const inside = floorRadius(createArena(INITIAL - STEP)) - 20; // safely in
    g.loadState(
      matchState(
        [pawnAt("p0", CX, CY - inside), pawnAt("p1", CX, CY + inside)],
        { roundsSinceShrink: EVERY - 1 }
      )
    );
    playEmptyRound(g);

    const s = g.getState();
    expect(s.arena!.radius).toBe(INITIAL - STEP);
    expect(s.pawns.map((p) => p.eliminated)).toEqual([false, false]);
    expect(s.phase).toBe("aiming"); // the match simply continues
    g.destroy();
  });

  it("introduces NO physical wall: the world holds pawn bodies only", () => {
    // The whole-world guarantee (mirrors physics.test.ts): shrinking the
    // arena adds nothing to the physics world — there is no body to
    // collide with at ANY radius.
    const world = createPhysicsWorld();
    expect(world.engine.world.bodies).toHaveLength(0);
    world.arena.radius = MIN; // the smallest the arena ever gets
    expect(world.engine.world.bodies).toHaveLength(0);
    const pawn = world.createPawnBody("p0", CX, CY, PAWN_R);
    expect(world.engine.world.bodies).toHaveLength(1);
    // Pawns collide with pawns and nothing else — no wall category exists.
    expect(pawn.collisionFilter.mask).toBe(0x0001);
    world.destroy();
  });

  it("still lets pawns leave the shrunken arena freely (no bounce)", () => {
    const g = createGame({ players: specs(2) });
    g.loadState(
      matchState([pawnAt("p0", CX, CY - 40), pawnAt("p1", CX, CY + 40)], {
        radius: MIN, // the smallest arena: the tightest possible "wall"
      })
    );
    // p0 launches hard outward through where a wall would be.
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY - 400 });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    g.applyCommand({ type: "resolveRound" });

    let maxDist = 0;
    let reversed = false;
    let guard = 0;
    while (g.getState().phase === "moving" && guard++ < 5000) {
      g.update(DT);
      const p0 = g.getState().pawns.find((p) => p.id === "p0")!;
      const d = distFromCenter(p0.position);
      if (d + 1e-9 < maxDist) reversed = true; // a wall would push it back
      maxDist = Math.max(maxDist, d);
    }
    expect(reversed).toBe(false); // it never turned around
    expect(maxDist).toBeGreaterThan(floorRadius(createArena(MIN)) + PAWN_R);
    expect(
      g.getState().pawns.find((p) => p.id === "p0")!.eliminated
    ).toBe(true);
    g.destroy();
  });

  it("uses the CURRENT radius for elimination — the same pawn survives at 330 and dies at 240", () => {
    // One position, two arenas: proof that shrinking is exactly a change
    // of the geometric rule's input.
    const between = floorRadius(createArena(270)) - 2; // inside 270, outside 240
    const big = createArena(330);
    const small = createArena(240);
    expect(isPawnOutOfBounds(big, CX, CY + between, PAWN_R)).toBe(false);
    expect(isPawnOutOfBounds(small, CX, CY + between, PAWN_R)).toBe(true);
  });
});

describe("the authoritative radius reaches clients through the snapshot", () => {
  it("projects the current radius and the derived countdown", () => {
    const g = createGame({ players: specs(2) });
    const fresh = projectSnapshot(g.getState(), "p0");
    expect(fresh.arena).toEqual({
      radius: INITIAL,
      roundsUntilShrink: EVERY,
      nextRadius: INITIAL - STEP,
      shrinkWarning: false,
      atMinRadius: false,
    });

    for (let round = 1; round < EVERY; round++) playRound(g);
    // One round before the shrink: the warning is on, with the sizes.
    const warned = projectSnapshot(g.getState(), "p0");
    expect(warned.arena).toEqual({
      radius: INITIAL,
      roundsUntilShrink: 1,
      nextRadius: INITIAL - STEP,
      shrinkWarning: true,
      atMinRadius: false,
    });

    playRound(g);
    // After the shrink: new radius, warning gone, schedule restarted.
    const after = projectSnapshot(g.getState(), "p0");
    expect(after.arena).toEqual({
      radius: INITIAL - STEP,
      roundsUntilShrink: EVERY,
      nextRadius: INITIAL - STEP * 2,
      shrinkWarning: false,
      atMinRadius: false,
    });
    g.destroy();
  });

  it("reports the minimum with no further shrink and no warning", () => {
    const g = createGame({ players: specs(2) });
    g.loadState(
      matchState([pawnAt("p0", CX - 40, CY), pawnAt("p1", CX + 40, CY)], {
        radius: MIN,
        roundsSinceShrink: EVERY - 1, // would warn if a shrink were coming
      })
    );
    const snap = projectSnapshot(g.getState(), "p0");
    expect(snap.arena).toEqual({
      radius: MIN,
      roundsUntilShrink: null,
      nextRadius: null,
      shrinkWarning: false,
      atMinRadius: true,
    });
    g.destroy();
  });

  it("projects the same arena for every viewer (no privacy leak, no per-client math)", () => {
    const g = createGame({ players: specs(3) });
    for (let round = 1; round < EVERY; round++) playRound(g);
    const state = g.getState();
    const views = ["p0", "p1", "p2", null].map((id) =>
      projectSnapshot(state, id)
    );
    for (const v of views) expect(v.arena).toEqual(views[0].arena);
    // Still private where it must be: an aiming round reveals no launches.
    for (const v of views) {
      expect(v.pawns.every((p) => p.launch === null)).toBe(true);
    }
    g.destroy();
  });

  it("gives clients drawable geometry straight from the snapshot", () => {
    const g = createGame({ players: specs(2) });
    g.loadState(
      matchState([pawnAt("p0", CX - 40, CY), pawnAt("p1", CX + 40, CY)], {
        radius: 240,
      })
    );
    const snap = projectSnapshot(g.getState(), "p0");
    const arena = arenaFromSnapshot(snap);
    expect(arena.radius).toBe(240);
    expect(arena.centerX).toBe(CX);
    expect(arena.centerY).toBe(CY);
    expect(floorRadius(arena)).toBe(240 - CONFIG.arena.wallThickness);
    g.destroy();
  });

  it("falls back to the full-size arena for a snapshot without the field", () => {
    // Backward-safe: an older server (or a hand-built snapshot) simply
    // describes a full arena instead of crashing the renderer.
    expect(arenaFromSnapshot({}).radius).toBe(INITIAL);
    expect(arenaFromSnapshot({ arena: undefined }).radius).toBe(INITIAL);
  });
});

describe("state transfer: reconnects and late snapshots", () => {
  it("round-trips the radius and the schedule position", () => {
    const g = createGame({ players: specs(2) });
    for (let round = 1; round <= EVERY + 1; round++) playRound(g);
    const state = g.getState();
    expect(state.arena).toEqual({
      radius: INITIAL - STEP,
      roundsSinceShrink: 1,
    });

    const restored = deserializeGameState(serializeGameState(state));
    expect(restored).toEqual(state);
    expect(restored.arena).toEqual(state.arena);
    g.destroy();
  });

  it("a client that joins late derives the CURRENT radius and countdown", () => {
    // The reconnect path exactly: serialize the authoritative state,
    // rebuild a fresh engine from it, project for the returning player.
    const live = createGame({ players: specs(2) });
    for (let round = 1; round <= EVERY * 2 - 1; round++) playRound(live);
    const wire = serializeGameState(live.getState());

    const rebuilt = createGame({ players: specs(2) });
    rebuilt.loadState(deserializeGameState(wire));

    expect(rebuilt.getState().arena).toEqual(live.getState().arena);
    const late = projectSnapshot(rebuilt.getState(), "p1");
    expect(late.arena).toEqual(projectSnapshot(live.getState(), "p1").arena);
    // Mid-schedule: shrunk once, and warning that the next one is due.
    expect(late.arena!.radius).toBe(INITIAL - STEP);
    expect(late.arena!.roundsUntilShrink).toBe(1);
    expect(late.arena!.shrinkWarning).toBe(true);
    live.destroy();
    rebuilt.destroy();
  });

  it("continues the schedule deterministically after a transfer", () => {
    const build = () => {
      const g = createGame({ players: specs(2) });
      for (let round = 1; round < EVERY; round++) playRound(g);
      return g;
    };
    const a = build();
    const b = createGame({ players: specs(2) });
    b.loadState(deserializeGameState(serializeGameState(a.getState())));

    for (const g of [a, b]) playRound(g); // both cross the trigger round
    expect(b.getState().arena).toEqual(a.getState().arena);
    expect(a.getState().arena!.radius).toBe(INITIAL - STEP);
    a.destroy();
    b.destroy();
  });

  it("accepts a state from before the mechanic as a full-size arena", () => {
    // Backward-safety at the trust boundary: no `arena` field at all.
    const legacy = {
      phase: "aiming" as const,
      winnerId: null,
      round: { settleTicks: 0 },
      pawns: [pawnAt("p0", CX - 40, CY), pawnAt("p1", CX + 40, CY)],
    };
    expect(() => validateGameState(legacy)).not.toThrow();
    const g = createGame({ players: specs(2) });
    g.loadState(legacy as GameState);
    expect(g.getState().arena).toEqual({
      radius: INITIAL,
      roundsSinceShrink: 0,
    });
    g.destroy();
  });

  it("rejects an out-of-range radius from the wire (untrusted input)", () => {
    const base = matchState([pawnAt("p0", CX, CY)]);
    expect(() =>
      validateGameState({ ...base, arena: { radius: 9_000, roundsSinceShrink: 0 } })
    ).toThrow(/arena.radius/);
    expect(() =>
      validateGameState({ ...base, arena: { radius: 1, roundsSinceShrink: 0 } })
    ).toThrow(/arena.radius/);
    expect(() =>
      validateGameState({ ...base, arena: { radius: INITIAL, roundsSinceShrink: -1 } })
    ).toThrow(/roundsSinceShrink/);
    expect(() =>
      validateGameState({ ...base, arena: { radius: INITIAL, roundsSinceShrink: 1.5 } })
    ).toThrow(/roundsSinceShrink/);
  });

  it("eliminates a pawn that a transferred smaller arena leaves outside", () => {
    // A late/rebuilt client must not show a pawn standing outside the
    // arena: the authoritative engine settles that on its next round.
    const g = createGame({ players: specs(2) });
    const outside = floorRadius(createArena(MIN)) + PAWN_R + 30;
    g.loadState(
      matchState(
        [pawnAt("p0", CX, CY), pawnAt("p1", CX, CY + outside)],
        { radius: MIN, phase: "moving" }
      )
    );
    let guard = 0;
    while (g.getState().phase === "moving" && guard++ < 5000) g.update(DT);
    const p1 = g.getState().pawns.find((p) => p.id === "p1")!;
    expect(p1.eliminated).toBe(true);
    g.destroy();
  });
});

describe("reset restores the initial arena and the schedule", () => {
  it("puts a shrunken match back to the full radius with a fresh schedule", () => {
    const g = createGame({ players: specs(2) });
    for (let round = 1; round <= EVERY * 2; round++) playRound(g);
    expect(radiusOf(g)).toBe(INITIAL - STEP * 2);
    expect(g.getState().arena!.roundsSinceShrink).toBe(0);

    g.applyCommand({ type: "reset" });

    const s = g.getState();
    expect(s.arena).toEqual({ radius: INITIAL, roundsSinceShrink: 0 });
    expect(s.phase).toBe("aiming");
    // A new match must shrink on the SAME schedule again, from scratch.
    for (let round = 1; round < EVERY; round++) playRound(g);
    expect(radiusOf(g)).toBe(INITIAL);
    playRound(g);
    expect(radiusOf(g)).toBe(INITIAL - STEP);
    g.destroy();
  });

  it("respawns pawns on the FULL floor after a reset from a tiny arena", () => {
    const g = createGame({ players: specs(2) });
    g.loadState(
      matchState([pawnAt("p0", CX - 20, CY), pawnAt("p1", CX + 20, CY)], {
        radius: MIN,
      })
    );
    g.applyCommand({ type: "reset" });
    const s = g.getState();
    expect(s.arena!.radius).toBe(INITIAL);
    // Everyone is alive and inside the restored arena.
    const arena = createArena(s.arena!.radius);
    for (const p of s.pawns) {
      expect(p.eliminated).toBe(false);
      expect(
        isPawnOutOfBounds(arena, p.position.x, p.position.y, p.radius)
      ).toBe(false);
    }
    g.destroy();
  });
});
