import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  createArena,
  createGame,
  deserializeGameState,
  spawnPositionForSlot,
  projectSnapshot,
  serializeGameState,
  validateGameState,
  type GameHandle,
  type GameStateSnapshot,
} from "../index";
import type { GameCommand } from "../commands";
import type { GameState } from "../state";

/**
 * The committed-launch REVEAL and the aiming PRIVACY that surrounds it —
 * the authoritative-side contract behind the multiplayer aiming UX:
 *
 *  - while a round is being decided ("aiming"), each player's aim/power
 *    is PRIVATE: a viewer's projection carries ONLY their own selection.
 *    Other pawns expose nothing but public readiness (confirmed) — there
 *    is no field to leak a direction through, so privacy does not depend
 *    on UI behavior (labels refer to the Task 13 spec):
 *
 *    9/10  neither projection exposes the other player's aim
 *    11    readiness stays visible without exposing direction
 *
 *  - the moment the round resolves ("moving"), every confirmed player's
 *    COMMITTED launch (direction + power, exactly as fired) becomes
 *    public fact in the authoritative state and is projected to EVERY
 *    viewer — including a player who never aimed explicitly (the default
 *    launch) and one who has since disconnected (the datum lives in the
 *    match state, not in any connection):
 *
 *    12    confirmed launches are visible to everyone during moving
 *    13    unconfirmed players carry no launch (never a guessed one)
 *    14-16 players choose independently (2- and 4-player rosters); one
 *          player's choice can never overwrite another's
 *    17    the launch datum survives the serialization boundary
 *
 *  - a NEW aiming round (or a reset) clears every launch: the previous
 *    round's reveal must never leak into a fresh round.
 */

const CX = CONFIG.arena.centerX;
const DT = CONFIG.simulation.fixedTimestepMs;

/**
 * Aim targets and the exact unit direction each produces, DERIVED from
 * the seat's fixed spawn slot (arena.ts) so the reveal assertions follow
 * the one spawn-position source of truth.
 *
 * Every seat aims straight at the arena center: the resulting direction
 * is the unit vector from that seat's spawn toward the middle, which is
 * distinct for every slot (they sit on different sides of the arena) —
 * exactly what these privacy tests need.
 */
const ARENA = createArena();
const AIM_TARGETS = Array.from({ length: CONFIG.match.maxPlayers }, () => ({
  x: CONFIG.arena.centerX,
  y: CONFIG.arena.centerY,
}));
const AIM_DIRECTIONS = Array.from(
  { length: CONFIG.match.maxPlayers },
  (_, slot) => {
    const [sx, sy] = spawnPositionForSlot(ARENA, slot);
    const dx = CONFIG.arena.centerX - sx;
    const dy = CONFIG.arena.centerY - sy;
    const len = Math.hypot(dx, dy);
    return { x: dx / len, y: dy / len };
  }
);

/** Assert a projected aim/launch direction equals a slot's inward unit. */
function expectDirection(
  actual: { x: number; y: number } | null | undefined,
  expected: { x: number; y: number }
): void {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, 9);
  expect(actual!.y).toBeCloseTo(expected.y, 9);
}

/**
 * The direction the engine launches with when a player never aimed (the
 * pawn's initial aim state) — used by the "silent player" reveal case.
 */
const DEFAULT_LAUNCH_DIRECTION = { x: 0, y: -1 };

const liveGames: GameHandle[] = [];
function game(n: number): GameHandle {
  const g = createGame({
    players: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      name: `Player ${i + 1}`,
    })),
  });
  liveGames.push(g);
  return g;
}

afterEach(() => {
  for (const g of liveGames) g.destroy();
  liveGames.length = 0;
});

/** Apply commands, asserting each is accepted. */
function run(g: GameHandle, ...commands: GameCommand[]): void {
  for (const command of commands) {
    expect(g.applyCommand(command)).toEqual({ ok: true });
  }
}

/** Advance until the phase changes (or maxFrames — no real waiting). */
function pumpUntil(
  g: GameHandle,
  phase: GameState["phase"],
  maxFrames = 900
): boolean {
  for (let i = 0; i < maxFrames; i++) {
    if (g.getState().phase === phase) return true;
    g.update(DT);
  }
  return g.getState().phase === phase;
}

const viewOf = (g: GameHandle, id: string): GameStateSnapshot =>
  projectSnapshot(g.getState(), id);

// ── privacy during aiming (9, 10, 11) ────────────────────────────────────

describe("committed launches — aiming privacy", () => {
  it("each viewer's projection carries ONLY their own aim (the other player's is structurally absent)", () => {
    const g = game(2);
    // p0 aims down, p1 aims up — each toward the arena center's far side.
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "aim", playerId: "p1", ...AIM_TARGETS[1] }
    );
    // p0 has already locked in — readiness is public knowledge…
    run(g, { type: "confirmLaunch", playerId: "p0" });

    const asP0 = viewOf(g, "p0");
    const asP1 = viewOf(g, "p1");

    // Each view shows its OWN current direction…
    expectDirection(asP0.aimDirection, AIM_DIRECTIONS[0]);
    expectDirection(asP1.aimDirection, AIM_DIRECTIONS[1]);
    // …and NOT the other player's.
    expect(asP0.aimDirection).not.toEqual(asP1.aimDirection);
    expect(asP0.power).toBe(CONFIG.power.default); // own standing power

    // The other player's pawn exposes ONLY public facts. There is no
    // per-pawn aim/power field in the projection at all — privacy is
    // structural, not a UI decision.
    for (const view of [asP0, asP1]) {
      expect(view.phase).toBe("aiming");
      for (const pawn of view.pawns) {
        expect(pawn.launch).toBeNull(); // the reveal gate: hard-null while aiming
        expect(Object.keys(pawn).sort()).toEqual(
          [
            "id",
            "name",
            "position",
            "velocity",
            "radius",
            "eliminated",
            "confirmed",
            "launch",
            "isLocal",
            "colorIndex",
          ].sort()
        );
      }
    }

    // 11: readiness is visible to everyone without any direction data.
    expect(asP0.pawns.find((p) => p.id === "p0")!.confirmed).toBe(true);
    expect(asP1.pawns.find((p) => p.id === "p0")!.confirmed).toBe(true);
    expect(asP1.pawns.find((p) => p.id === "p1")!.confirmed).toBe(false);
  });

  it("a spectator projection (no local pawn) sees nobody's aim", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "aim", playerId: "p1", ...AIM_TARGETS[1] }
    );
    const spectate = projectSnapshot(g.getState(), null);
    expect(spectate.aimDirection).toBeNull();
    expect(spectate.power).toBe(CONFIG.power.default); // neutral default
    expect(spectate.isAiming).toBe(false);
    expect(spectate.pawns.every((p) => p.launch === null)).toBe(true);
  });
});

// ── reveal on resolution (12, 13, 14-16) ─────────────────────────────────

describe("committed launches — resolution reveal", () => {
  it("once everyone confirmed, BOTH viewers see BOTH committed launches (exact direction + power)", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "setPower", playerId: "p0", power: 2 },
      { type: "aim", playerId: "p1", ...AIM_TARGETS[1] },
      { type: "setPower", playerId: "p1", power: 4 },
      { type: "confirmLaunch", playerId: "p0" }
    );
    // The last confirmation resolves the round immediately… but NOT at the
    // confirm itself: before p1 confirms, nothing has moved.
    expect(g.getState().phase).toBe("aiming"); // confirm ≠ launch (8)
    const before = g.getState().pawns.map((p) => ({ ...p.position }));
    run(g, { type: "confirmLaunch", playerId: "p1" });
    expect(g.getState().phase).toBe("moving"); // everyone confirmed → together

    for (const viewer of ["p0", "p1"]) {
      const view = viewOf(g, viewer);
      expect(view.pawns.find((p) => p.id === "p0")!.launch).toEqual({
        direction: AIM_DIRECTIONS[0],
        power: 2,
      });
      expect(view.pawns.find((p) => p.id === "p1")!.launch).toEqual({
        direction: AIM_DIRECTIONS[1],
        power: 4,
      });
    }

    // …and both pawns actually left their spawn in that ONE shared
    // resolution (the confirm alone had moved nothing).
    g.update(DT); // one fixed tick of the shared movement
    const moving = g.getState();
    for (const i of [0, 1]) {
      expect(
        Math.hypot(
          moving.pawns[i].position.x - before[i].x,
          moving.pawns[i].position.y - before[i].y
        )
      ).toBeGreaterThan(0);
    }
  });

  it("a server deadline resolution reveals the confirmed player's launch and nothing for the silent one (13)", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "setPower", playerId: "p0", power: 3 },
      { type: "confirmLaunch", playerId: "p0" }
    );
    // The match-level resolveRound (what the server's deadline submits).
    run(g, { type: "resolveRound" });
    expect(g.getState().phase).toBe("moving");

    const asP1 = viewOf(g, "p1"); // the player who never chose
    expect(asP1.pawns.find((p) => p.id === "p0")!.launch).toEqual({
      direction: AIM_DIRECTIONS[0],
      power: 3,
    });
    // Unconfirmed → no launch datum → no arrow. Never a guessed one.
    expect(asP1.pawns.find((p) => p.id === "p1")!.launch).toBeNull();
    // The same is true in the raw authoritative state.
    expect(g.getState().pawns.find((p) => p.id === "p1")!.lastLaunch).toBeNull();
  });

  it("a confirmed launch without an explicit aim reveals the DEFAULT launch direction", () => {
    const g = game(2);
    run(g, { type: "confirmLaunch", playerId: "p0" });
    run(g, { type: "resolveRound" });
    expect(g.getState().phase).toBe("moving");
    const view = viewOf(g, "p1");
    expect(view.pawns.find((p) => p.id === "p0")!.launch).toEqual({
      direction: DEFAULT_LAUNCH_DIRECTION, // the engine's default
      power: CONFIG.power.default,
    });
  });

  it("four players choose independently — three launches revealed exactly as chosen, the silent fourth carries none (14-16)", () => {
    const g = game(4);
    const powers = [1, 3, 5, 2];
    for (const i of [0, 1, 2]) {
      run(
        g,
        { type: "aim", playerId: `p${i}`, ...AIM_TARGETS[i] },
        { type: "setPower", playerId: `p${i}`, power: powers[i] },
        { type: "confirmLaunch", playerId: `p${i}` }
      );
    }
    run(g, { type: "resolveRound" }); // p3 never chose — the deadline resolves
    expect(g.getState().phase).toBe("moving");

    // Every viewer sees the same public reveal…
    for (const viewer of ["p0", "p1", "p2", "p3"]) {
      const view = viewOf(g, viewer);
      for (const i of [0, 1, 2]) {
        expect(view.pawns.find((p) => p.id === `p${i}`)!.launch).toEqual({
          direction: AIM_DIRECTIONS[i],
          power: powers[i],
        });
      }
      expect(view.pawns.find((p) => p.id === "p3")!.launch).toBeNull();
    }
    // …and the authoritative state holds exactly the choices as made —
    // nobody's confirmation overwrote anybody else's.
    for (const i of [0, 1, 2]) {
      expect(g.getState().pawns.find((p) => p.id === `p${i}`)!.lastLaunch).toEqual({
        direction: AIM_DIRECTIONS[i],
        power: powers[i],
      });
    }
  });

  it("confirmation locks aim and power for the round — later intents are rejected and the reveal keeps the locked values (7)", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "setPower", playerId: "p0", power: 2 },
      { type: "confirmLaunch", playerId: "p0" }
    );
    // Locked: no further aim/power/confirm from p0 this round.
    for (const command of [
      { type: "aim", playerId: "p0", ...AIM_TARGETS[2] },
      { type: "setPower", playerId: "p0", power: 5 },
      { type: "confirmLaunch", playerId: "p0" },
    ] as GameCommand[]) {
      expect(g.applyCommand(command)).toEqual({
        ok: false,
        reason: "already-confirmed",
      });
    }
    // p1 stays free to choose (simultaneous rounds) — and locks a
    // DIFFERENT power, independently of p0's earlier confirmation.
    run(
      g,
      { type: "aim", playerId: "p1", ...AIM_TARGETS[1] },
      { type: "setPower", playerId: "p1", power: 5 },
      { type: "confirmLaunch", playerId: "p1" } // completes the set → moving
    );
    expect(g.getState().phase).toBe("moving");
    const view = viewOf(g, "p1");
    expect(view.pawns.find((p) => p.id === "p0")!.launch).toEqual({
      direction: AIM_DIRECTIONS[0], // p0's locked aim — not the rejected update
      power: 2, // p0's locked power
    });
    expect(view.pawns.find((p) => p.id === "p1")!.launch).toEqual({
      direction: AIM_DIRECTIONS[1],
      power: 5,
    });
  });
});

// ── the reveal datum across boundaries and rounds (17, no-leak) ──────────

describe("committed launches — serialization and lifecycle", () => {
  it("launches survive the serialization boundary intact (the server broadcast path, 17)", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "setPower", playerId: "p0", power: 4 },
      { type: "confirmLaunch", playerId: "p0" },
      { type: "resolveRound" }
    );
    const moving = g.getState();
    const restored = deserializeGameState(serializeGameState(moving));
    expect(restored.pawns.find((p) => p.id === "p0")!.lastLaunch).toEqual({
      direction: AIM_DIRECTIONS[0],
      power: 4,
    });
    expect(restored.pawns.find((p) => p.id === "p1")!.lastLaunch).toBeNull();
    // And the restored state projects the same reveal to every viewer.
    expect(projectSnapshot(restored, "p1").pawns[0].launch).toEqual({
      direction: AIM_DIRECTIONS[0],
      power: 4,
    });
  });

  it("a fresh aiming round reveals NOTHING — the previous round's launches are cleared for every pawn", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "setPower", playerId: "p0", power: 2 },
      { type: "aim", playerId: "p1", ...AIM_TARGETS[1] },
      { type: "setPower", playerId: "p1", power: 2 },
      { type: "confirmLaunch", playerId: "p0" },
      { type: "confirmLaunch", playerId: "p1" }
    );
    expect(g.getState().phase).toBe("moving");
    expect(g.getState().pawns.every((p) => p.lastLaunch !== null)).toBe(true);

    // The round settles into a new aiming round (fixed ticks, no waiting).
    expect(pumpUntil(g, "aiming")).toBe(true);
    const state = g.getState();
    expect(state.pawns.every((p) => p.lastLaunch === null)).toBe(true);
    for (const viewer of ["p0", "p1"]) {
      const view = viewOf(g, viewer);
      expect(view.pawns.every((p) => p.launch === null)).toBe(true);
      expect(view.pawns.every((p) => !p.confirmed)).toBe(true); // fresh round
    }
  });

  it("a reset clears every committed launch (a fresh match reveals nothing)", () => {
    const g = game(2);
    run(
      g,
      { type: "aim", playerId: "p0", ...AIM_TARGETS[0] },
      { type: "confirmLaunch", playerId: "p0" },
      { type: "resolveRound" }
    );
    expect(g.getState().phase).toBe("moving");
    run(g, { type: "reset" });
    const state = g.getState();
    expect(state.phase).toBe("aiming");
    expect(state.pawns.every((p) => p.lastLaunch === null)).toBe(true);
    expect(viewOf(g, "p0").pawns.every((p) => p.launch === null)).toBe(true);
  });

  it("a finished match keeps the final round's committed launches visible (final state may show them)", () => {
    // Single-player self-knockout finishes the match quickly.
    const g = game(1);
    const spawn = { ...g.getState().pawns[0].position };
    // Aim straight out through the nearest rim at full power.
    const out = {
      x: CX + ((spawn.x - CX) / Math.max(1, Math.abs(spawn.x - CX))) * 400,
      y: spawn.y,
    };
    run(
      g,
      { type: "aim", playerId: "p0", x: out.x, y: out.y },
      { type: "setPower", playerId: "p0", power: 5 },
      { type: "confirmLaunch", playerId: "p0" } // the only player → resolves
    );
    expect(pumpUntil(g, "finished")).toBe(true);
    const state = g.getState();
    expect(state.winnerId).toBeNull(); // knocked itself out
    // The final launch remains part of the terminal state (and its
    // projection) — "what everyone fired last" is appropriate to show.
    expect(state.pawns[0].lastLaunch).not.toBeNull();
    expect(state.pawns[0].lastLaunch!.power).toBe(5);
    expect(viewOf(g, "p0").pawns[0].launch).not.toBeNull();
  });
});

// ── validation of the new datum (trust boundary) ─────────────────────────

describe("committed launches — state validation", () => {
  it("validateGameState rejects malformed committed launches", () => {
    const base = () => {
      const g = game(2);
      run(g, { type: "confirmLaunch", playerId: "p0" }, { type: "resolveRound" });
      return serializeGameState(g.getState()); // a valid moving state
    };
    const valid = JSON.parse(base());
    expect(() => validateGameState(valid)).not.toThrow();

    // Power outside the scale.
    const badPower = structuredClone(valid);
    badPower.pawns[0].lastLaunch.power = 9;
    expect(() => validateGameState(badPower)).toThrow(/lastLaunch.power/);

    // Non-unit direction.
    const badDirection = structuredClone(valid);
    badDirection.pawns[0].lastLaunch.direction = { x: 2, y: 0 };
    expect(() => validateGameState(badDirection)).toThrow(/lastLaunch.direction/);

    // Not an object at all.
    const badShape = structuredClone(valid);
    badShape.pawns[0].lastLaunch = "down";
    expect(() => validateGameState(badShape)).toThrow(/lastLaunch/);
  });

  it("validateGameState tolerates ABSENT lastLaunch (older serialized states) as 'no launch'", () => {
    const g = game(2);
    const legacy = JSON.parse(serializeGameState(g.getState()));
    for (const pawn of legacy.pawns) delete pawn.lastLaunch;
    expect(() => validateGameState(legacy)).not.toThrow();
    // Loading such a state keeps the engine consistent (null, not undefined).
    g.loadState(legacy);
    expect(g.getState().pawns.every((p) => p.lastLaunch === null)).toBe(true);
  });
});
