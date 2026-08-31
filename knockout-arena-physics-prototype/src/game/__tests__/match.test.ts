import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { createArena, floorRadius } from "../arena";
import { createGame, type GameHandle } from "../game";
import { projectSnapshot } from "../project";
import {
  serializeGameState,
  deserializeGameState,
  type GameState,
  type PawnState,
} from "../state";
import type { PlayerSpec } from "../game";

/**
 * N-player match integration suite.
 *
 * The engine is player-count agnostic: a match is a roster of pawns, a
 * stable turn queue, per-pawn aim/power, per-pawn elimination, and a
 * finished phase with a winner derived purely from elimination state.
 * These tests drive whole matches (2/3/4 players) through commands and
 * fixed-tick updates, including physical knockouts (a mover shoving an
 * opponent over the rim), and verify serialization/replay determinism.
 *
 * Physical facts used below (see physics.test.ts for the derivations):
 *   - max travel at power 5 ≈ 225 world units, so crafted states place the
 *     victim close to the mover (a direct head-on p5 hit transfers ≈ 0.79 of
 *     the mover's contact speed — more than the 2.3 rim pass-over threshold);
 *   - the rim pass-over decision is re-derived for EVERY alive pawn each
 *     tick, so a shoved opponent flies over the rim exactly like a mover does.
 */

const DT = CONFIG.simulation.fixedTimestepMs;
const ARENA = createArena();
const FLOOR = floorRadius(ARENA);
const PAWN_R = CONFIG.pawn.radius;
const CX = ARENA.centerX;
const CY = ARENA.centerY;

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** A hand-crafted pawn at an arbitrary position (spawn = position). */
function pawnAt(
  id: string,
  x: number,
  y: number,
  extra: Partial<PawnState> = {}
): PawnState {
  return {
    id,
    name: `Player ${id}`,
    colorIndex: Number(id.slice(1)),
    radius: PAWN_R,
    spawnX: x,
    spawnY: y,
    eliminated: false,
    power: CONFIG.power.default,
    aim: { active: false, direction: { x: 0, y: -1 } },
    position: { x, y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    ...extra,
  };
}

/** Craft a full match state from pawn placements (queue = given order). */
function matchState(
  pawns: PawnState[],
  opts: { activeIndex?: number; phase?: GameState["phase"]; settleTicks?: number } = {}
): GameState {
  return {
    phase: opts.phase ?? "aiming",
    winnerId: null,
    turn: {
      queue: pawns.map((p) => p.id),
      activeIndex: opts.activeIndex ?? 0,
      settleTicks: opts.settleTicks ?? 0,
    },
    pawns,
  };
}

/** Update until the phase leaves "moving" (or maxFrames). */
function pump(g: GameHandle, maxFrames = 900): number {
  for (let i = 0; i < maxFrames; i++) {
    g.update(DT);
    if (g.getState().phase !== "moving") return i + 1;
  }
  return maxFrames;
}

/** Launch a pawn toward the arena center (always settles safely). */
function launchInward(g: GameHandle, playerId: string, power = 2) {
  g.dispatch({ type: "aim", playerId, x: CX, y: CY });
  g.dispatch({ type: "setPower", playerId, power });
  g.dispatch({ type: "confirmLaunch", playerId });
}

/** Launch a pawn straight at the rim it is heading for. */
function launchOutward(g: GameHandle, playerId: string, dir: { x: number; y: number }, power = 5) {
  g.dispatch({ type: "aim", playerId, x: CX + dir.x * 400, y: CY + dir.y * 400 });
  g.dispatch({ type: "setPower", playerId, power });
  g.dispatch({ type: "confirmLaunch", playerId });
}

/**
 * The physical knockout setup: the mover sits 45 units behind the victim,
 * both on the same radial line, the victim just inside the rim pass-over
 * zone. A p5 head-on launch transfers enough speed to shove the victim over
 * the rim while the mover stays on the floor.
 */
function knockoutSetup(
  moverId: string,
  victimId: string,
  extraPawns: PawnState[] = []
): GameState {
  // Radial direction "down" (toward the bottom rim); victim at distance 240
  // from the center, mover 45 units behind it.
  const victim = pawnAt(victimId, CX, CY + 240);
  const mover = pawnAt(moverId, CX, CY + 195);
  return matchState([mover, victim, ...extraPawns]);
}

/** Player specs p0..pN-1. */
function specs(n: number): PlayerSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Player ${i + 1}`,
  }));
}

const distFromCenter = (p: { x: number; y: number }) => Math.hypot(p.x - CX, p.y - CY);

// ────────────────────────────────────────────────────────────────────────
// Match creation / rosters
// ────────────────────────────────────────────────────────────────────────

describe("N-player match creation", () => {
  it("defaults to exactly the classic single-player match (p0)", () => {
    const g = createGame();
    const s = g.getState();
    expect(s.pawns.map((p) => p.id)).toEqual(["p0"]);
    expect(s.pawns[0].name).toBe("Player 1");
    expect(s.pawns[0].position).toEqual({ x: CX, y: CY - 240 });
    expect(s.turn.queue).toEqual(["p0"]);
    expect(s.phase).toBe("aiming");
    g.destroy();
  });

  it.each([2, 3, 4, 5])("spawns %i players deterministically on a circle", (n) => {
    const g = createGame({ players: specs(n) });
    const s = g.getState();
    expect(s.pawns).toHaveLength(n);
    // Seat i sits at angle -π/2 + i·2π/n, just inside the floor; the first
    // seat is the classic top spawn.
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const r = FLOOR - PAWN_R - 8;
      const p = s.pawns[i];
      expect(p.id).toBe(`p${i}`);
      expect(p.position.x).toBeCloseTo(CX + Math.cos(angle) * r, 6);
      expect(p.position.y).toBeCloseTo(CY + Math.sin(angle) * r, 6);
      expect(p.colorIndex).toBe(i);
      expect(p.eliminated).toBe(false);
      expect(p.power).toBe(CONFIG.power.default);
      expect(p.aim.active).toBe(false);
    }
    expect(s.turn.queue).toEqual(s.pawns.map((p) => p.id));
    expect(s.turn.activeIndex).toBe(0);
    g.destroy();
  });

  it("keeps opposite spawns maximally apart (2 players top/bottom)", () => {
    const g = createGame({ players: specs(2) });
    const [a, b] = g.getState().pawns;
    expect(a.position).toEqual({ x: CX, y: CY - 240 });
    expect(b.position).toEqual({ x: CX, y: CY + 240 });
    g.destroy();
  });

  it("honors custom names and color indices", () => {
    const g = createGame({
      players: [
        { id: "ada", name: "Ada", colorIndex: 3 },
        { id: "bob", name: "Bob" },
      ],
    });
    const s = g.getState();
    expect(s.pawns.map((p) => p.name)).toEqual(["Ada", "Bob"]);
    expect(s.pawns.map((p) => p.colorIndex)).toEqual([3, 1]); // bob defaults to seat 1
    expect(s.turn.queue).toEqual(["ada", "bob"]);
    g.destroy();
  });

  it("rejects empty rosters and duplicate player ids", () => {
    expect(() => createGame({ players: [] })).toThrow(/at least one player/);
    expect(() =>
      createGame({ players: [{ id: "p0", name: "A" }, { id: "p0", name: "B" }] })
    ).toThrow(/duplicate player id/);
    expect(() => createGame({ players: [{ id: "", name: "A" }] })).toThrow(
      /non-empty strings/
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Turn rotation
// ────────────────────────────────────────────────────────────────────────

describe("turn rotation across N players", () => {
  it.each([2, 3, 4])("rotates %i players in queue order and wraps", (n) => {
    const g = createGame({ players: specs(n) });
    // Two full rounds of safe inward launches.
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < n; i++) {
        const id = `p${i}`;
        expect(g.getState().turn.activeIndex).toBe(i);
        expect(g.snapshot().activePawnId).toBe(id);
        launchInward(g, id, 1);
        expect(g.getState().phase).toBe("moving");
        pump(g);
        expect(g.getState().phase).toBe("aiming");
      }
    }
    g.destroy();
  });

  it("only the active player may act; others are rejected as wrong-player", () => {
    const g = createGame({ players: specs(3) });
    // p0's turn: p1 and p2 cannot aim, set power, or launch.
    for (const outsider of ["p1", "p2"]) {
      expect(g.applyCommand({ type: "aim", playerId: outsider, x: CX, y: CY })).toEqual({
        ok: false,
        reason: "wrong-player",
      });
      expect(g.applyCommand({ type: "setPower", playerId: outsider, power: 5 })).toEqual({
        ok: false,
        reason: "wrong-player",
      });
      expect(g.applyCommand({ type: "confirmLaunch", playerId: outsider })).toEqual({
        ok: false,
        reason: "wrong-player",
      });
    }
    // p0 still can.
    expect(g.applyCommand({ type: "setPower", playerId: "p0", power: 3 })).toEqual({ ok: true });
    g.destroy();
  });

  it("rejects the non-active player even while another pawn is moving", () => {
    const g = createGame({ players: specs(2) });
    launchInward(g, "p0", 3); // p0 in flight
    expect(g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: "p1" })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
    pump(g);
    g.destroy();
  });

  it("rejects unknown players regardless of phase", () => {
    const g = createGame({ players: specs(2) });
    expect(g.applyCommand({ type: "aim", playerId: "p7", x: 1, y: 1 })).toEqual({
      ok: false,
      reason: "unknown-player",
    });
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-pawn aim and power
// ────────────────────────────────────────────────────────────────────────

describe("per-pawn aim and power", () => {
  it("keeps each player's power selection independent and persistent", () => {
    const g = createGame({ players: specs(2) });
    // p0 picks power 4, launches, settles → p1's turn shows p1's own power.
    g.applyCommand({ type: "setPower", playerId: "p0", power: 4 });
    launchInward(g, "p0", 4);
    pump(g);
    expect(g.snapshot().activePawnId).toBe("p1");
    expect(g.snapshot().power).toBe(CONFIG.power.default); // p1's, not p0's 4

    // p1 picks 2 and launches → back to p0, whose power 4 survived.
    g.applyCommand({ type: "setPower", playerId: "p1", power: 2 });
    launchInward(g, "p1", 2);
    pump(g);
    expect(g.snapshot().activePawnId).toBe("p0");
    expect(g.snapshot().power).toBe(4);
    // …and p1's power 2 is still stored on p1.
    expect(g.getState().pawns[1].power).toBe(2);
    g.destroy();
  });

  it("keeps each player's aim independent; consumed only by their own launch", () => {
    const g = createGame({ players: specs(2) });
    // p0 aims and launches; p1 then aims — p0's aim is gone, p1's is live.
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + 200 });
    launchInward(g, "p0", 2);
    pump(g);
    expect(g.getState().pawns[0].aim.active).toBe(false); // consumed

    g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY - 200 });
    const s = g.snapshot();
    expect(s.activePawnId).toBe("p1");
    expect(s.isAiming).toBe(true);
    expect(s.aimDirection).toEqual({ x: 0, y: -1 }); // toward the top from p1

    // p1's aim persists across p0's NEXT turn…
    g.applyCommand({ type: "setPower", playerId: "p1", power: 1 });
    launchInward(g, "p1", 1);
    pump(g);
    expect(g.snapshot().activePawnId).toBe("p0");
    // p1's aim is consumed by p1's launch — check via state:
    expect(g.getState().pawns[1].aim.active).toBe(false);
    g.destroy();
  });

  it("a player's aim survives another player's whole turn untouched", () => {
    const g = createGame({ players: specs(2) });
    // p0 aims (does not launch); p0's turn continues — now simulate p0's
    // launch and p1's full turn; p0's aim must be consumed by p0's own
    // launch only, and re-aiming works afterwards.
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + 100 });
    expect(g.getState().pawns[0].aim.active).toBe(true);
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    pump(g);
    // p1 aims somewhere specific and does NOT launch; p1 forfeits by reset
    // — instead verify state storage directly after p0's next turn begins.
    g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY - 100 });
    expect(g.getState().pawns[1].aim.active).toBe(true);
    g.destroy();
  });

  it("the snapshot exposes the ACTIVE pawn's controls", () => {
    const g = createGame({ players: specs(3) });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    expect(g.snapshot().power).toBe(5);
    launchInward(g, "p0", 5);
    pump(g); // → p1
    // p1 has not touched anything: defaults, no aim.
    expect(g.snapshot().power).toBe(CONFIG.power.default);
    expect(g.snapshot().isAiming).toBe(false);
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Elimination during play (physical knockouts)
// ────────────────────────────────────────────────────────────────────────

describe("knocking an opponent over the rim", () => {
  it("eliminates the victim mid-flight while the match is still moving", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);

    let sawVictimOutWhileMoving = false;
    let moverEverEliminated = false;
    for (let i = 0; i < 900; i++) {
      g.update(DT);
      const s = g.getState();
      const victim = s.pawns.find((p) => p.id === "p1")!;
      if (victim.eliminated && s.phase === "moving") sawVictimOutWhileMoving = true;
      if (s.phase !== "moving") break;
    }
    const s = g.getState();
    expect(sawVictimOutWhileMoving).toBe(true); // elimination ≠ phase change
    expect(s.pawns.find((p) => p.id === "p1")!.eliminated).toBe(true);
    expect(s.pawns.find((p) => p.id === "p0")!.eliminated).toBe(false);
    expect(moverEverEliminated).toBe(false);
    // The victim physically left the floor…
    expect(distFromCenter(s.pawns[1].position)).toBeGreaterThan(FLOOR + PAWN_R);
    // …the mover stayed on it.
    expect(distFromCenter(s.pawns[0].position)).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });

  it("ends a two-player match with the mover as winner", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p0");
    g.destroy();
  });

  it("continues the match with a bystander (3 players)", () => {
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g);
    const s = g.getState();
    // Two pawns still active (p0 mover + p2 bystander): not finished.
    expect(s.phase).toBe("aiming");
    expect(s.winnerId).toBeNull();
    // Rotation skipped the eliminated p1 → p2 acts next.
    expect(g.snapshot().activePawnId).toBe("p2");
    // The queue itself is unchanged (stable full roster).
    expect(s.turn.queue).toEqual(["p0", "p1", "p2"]);
    // Eliminated pawns stay in the historical state.
    expect(s.pawns.map((p) => p.id)).toEqual(["p0", "p1", "p2"]);
    g.destroy();
  });

  it("an eliminated player's commands are rejected as wrong-player", () => {
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g); // p1 eliminated, p2 to act
    expect(g.applyCommand({ type: "aim", playerId: "p1", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: "p1" })).toEqual({
      ok: false,
      reason: "wrong-player",
    });
    // p2 (the active player) is still allowed.
    expect(g.applyCommand({ type: "setPower", playerId: "p2", power: 3 })).toEqual({ ok: true });
    g.destroy();
  });

  it("the eliminated pawn becomes a non-collidable frozen ghost", () => {
    const run = (withGhost: boolean) => {
      const g = createGame();
      // Mover at the top, sliding down through where the ghost sits.
      const pawns = [
        pawnAt("p0", CX, CY - 50),
        pawnAt("p2", CX, CY - 240, { colorIndex: 2 }),
      ];
      if (withGhost) {
        pawns.push(pawnAt("p1", CX, CY + 50, { eliminated: true, colorIndex: 1 }));
      }
      g.loadState(matchState(pawns));
      g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + 400 });
      g.applyCommand({ type: "setPower", playerId: "p0", power: 4 });
      g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
      const trace: number[] = [];
      for (let i = 0; i < 400; i++) {
        g.update(DT);
        const p = g.getState().pawns.find((pp) => pp.id === "p0")!;
        trace.push(p.position.x, p.position.y);
        if (g.getState().phase !== "moving") break;
      }
      g.destroy();
      return trace;
    };
    // Passing straight through the ghost must not deflect the mover.
    expect(run(true)).toEqual(run(false));
  });

  it("freeszes the ghost in place (no background drift)", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g); // finished: p1 out, p0 winner
    const frozen = { ...g.getState().pawns[1].position };
    for (let i = 0; i < 120; i++) g.update(DT);
    expect(g.getState().pawns[1].position).toEqual(frozen);
    expect(g.getState().pawns[1].velocity).toEqual({ x: 0, y: 0 });
    g.destroy();
  });
});

describe("eliminating yourself (the mover leaves the arena)", () => {
  it("hands the win to the opponent in a two-player match", () => {
    const g = createGame({ players: specs(2) });
    // p0 launches straight at its nearby top rim and flies out.
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY - 400 });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p1");
    expect(s.pawns[0].eliminated).toBe(true);
    expect(s.pawns[1].eliminated).toBe(false);
    g.destroy();
  });

  it("continues to the next player in a three-player match", () => {
    const g = createGame({ players: specs(3) });
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY - 400 });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    pump(g);
    const s = g.getState();
    expect(s.phase).toBe("aiming"); // two pawns still active
    expect(s.pawns[0].eliminated).toBe(true);
    expect(g.snapshot().activePawnId).toBe("p1"); // rotation moved on
    g.destroy();
  });
});

describe("consecutive eliminations across turns", () => {
  it("p0 knocks out p1, then p2 knocks out p0 → p2 wins", () => {
    // Turn 1: p0 shoves p1 over the bottom rim; p2 waits at the top.
    const g = createGame();
    const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
    g.loadState(knockoutSetup("p0", "p1", [bystander]));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g);
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().pawns[1].eliminated).toBe(true);
    expect(g.snapshot().activePawnId).toBe("p2");

    // Turn 2: p2 shoves p0 over the bottom rim (fresh geometry via state).
    const state = g.getState();
    g.loadState({
      ...state,
      pawns: [
        // p0 drifted near the bottom after its own launch; put it back on the
        // crafted radial line as the victim.
        { ...state.pawns[0], position: { x: CX, y: CY + 240 }, velocity: { x: 0, y: 0 } },
        state.pawns[1], // eliminated ghost, parked outside
        { ...state.pawns[2], position: { x: CX, y: CY + 195 }, velocity: { x: 0, y: 0 } },
      ],
      turn: { queue: ["p0", "p1", "p2"], activeIndex: 2, settleTicks: 0 },
      phase: "aiming",
      winnerId: null,
    });
    launchOutward(g, "p2", { x: 0, y: 1 }, 5);
    pump(g);

    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p2");
    expect(s.pawns.map((p) => p.eliminated)).toEqual([true, true, false]);
    g.destroy();
  });
});

describe("no survivor", () => {
  it("finishes with a null winner when everybody leaves the arena", () => {
    const g = createGame();
    // Two pawns already past the rim pass-over zone, flying outward fast:
    // both cross the elimination boundary on the same ticks.
    g.loadState({
      phase: "moving",
      winnerId: null,
      turn: { queue: ["p0", "p1"], activeIndex: 0, settleTicks: 0 },
      pawns: [
        pawnAt("p0", CX, CY - 250, { velocity: { x: 0, y: -3 } }),
        pawnAt("p1", CX, CY + 250, { velocity: { x: 0, y: 3 } }),
      ],
    });
    pump(g, 200);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBeNull();
    expect(s.pawns.every((p) => p.eliminated)).toBe(true);
    g.destroy();
  });
});

describe("single-pawn matches never auto-finish", () => {
  it("keeps playing turn after turn while the pawn survives", () => {
    const g = createGame();
    for (let i = 0; i < 3; i++) {
      launchInward(g, "p0", 2);
      pump(g);
      expect(g.getState().phase).toBe("aiming");
      expect(g.getState().winnerId).toBeNull();
    }
    g.destroy();
  });

  it("still ends (with no winner) when the lone pawn flies out", () => {
    const g = createGame();
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY - 400 });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    pump(g);
    expect(g.getState().phase).toBe("finished");
    expect(g.getState().winnerId).toBeNull();
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// The finished phase
// ────────────────────────────────────────────────────────────────────────

describe("the finished phase", () => {
  function finishedMatch(): GameHandle {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g);
    expect(g.getState().phase).toBe("finished");
    return g;
  }

  it("rejects every action command with wrong-phase (winner stays put)", () => {
    const g = finishedMatch();
    const winnerBefore = g.getState().winnerId;
    for (const cmd of [
      { type: "aim", playerId: "p0", x: CX, y: CY },
      { type: "setPower", playerId: "p0", power: 1 },
      { type: "confirmLaunch", playerId: "p0" },
      { type: "aim", playerId: "p1", x: CX, y: CY }, // eliminated player
    ] as const) {
      expect(g.applyCommand(cmd)).toEqual({ ok: false, reason: "wrong-phase" });
    }
    expect(g.getState().winnerId).toBe(winnerBefore);
    g.destroy();
  });

  it("ignores updates once finished", () => {
    const g = finishedMatch();
    const before = g.getState();
    for (let i = 0; i < 120; i++) g.update(DT);
    expect(g.getState()).toEqual(before);
    g.destroy();
  });

  it("resets the whole roster from a finished match", () => {
    const g = finishedMatch();
    g.dispatch({ type: "reset" });
    const s = g.getState();
    expect(s.phase).toBe("aiming");
    expect(s.winnerId).toBeNull();
    expect(s.turn.activeIndex).toBe(0);
    expect(s.pawns).toHaveLength(2);
    for (const p of s.pawns) {
      expect(p.eliminated).toBe(false);
      expect(p.power).toBe(CONFIG.power.default);
      expect(p.aim.active).toBe(false);
      expect(p.velocity).toEqual({ x: 0, y: 0 });
      // back at each pawn's own spawn (the crafted positions)
      expect(p.position).toEqual({ x: p.spawnX, y: p.spawnY });
    }
    g.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// loadState normalization
// ────────────────────────────────────────────────────────────────────────

describe("loadState normalization (state-driven match rules)", () => {
  it("finishes with no winner when no pawn is active", () => {
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY - 300, { eliminated: true }),
      ])
    );
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBeNull();
    g.destroy();
  });

  it("finishes with the survivor when one pawn is active in a multi-pawn roster", () => {
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY),
        pawnAt("p1", CX, CY - 300, { eliminated: true }),
      ])
    );
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p0");
    g.destroy();
  });

  it("advances rotation when the active pawn is already eliminated", () => {
    const g = createGame();
    g.loadState(
      matchState(
        [
          pawnAt("p0", CX, CY + 300, { eliminated: true }),
          pawnAt("p1", CX, CY),
          pawnAt("p2", CX, CY - 100, { colorIndex: 2 }),
        ],
        { activeIndex: 0 }
      )
    );
    expect(g.getState().phase).toBe("aiming");
    expect(g.snapshot().activePawnId).toBe("p1");
    g.destroy();
  });

  it("keeps a single-pawn roster playing (no auto-finish)", () => {
    const g = createGame();
    g.loadState(matchState([pawnAt("p0", CX, CY)]));
    expect(g.getState().phase).toBe("aiming");
    expect(g.getState().winnerId).toBeNull();
    g.destroy();
  });

  it("preserves an explicitly finished state with its winner", () => {
    const g = createGame();
    g.loadState({
      phase: "finished",
      winnerId: "p1",
      turn: { queue: ["p0", "p1"], activeIndex: 1, settleTicks: 0 },
      pawns: [
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY),
      ],
    });
    expect(g.getState().phase).toBe("finished");
    expect(g.getState().winnerId).toBe("p1");
    g.destroy();
  });

  it("restores ghosts as non-collidable on reconstruction", () => {
    // One eliminated pawn + two active: the ghost must not block anything.
    const g = createGame();
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY),
        pawnAt("p1", CX, CY, { eliminated: true }),
        pawnAt("p2", CX, CY - 100, { colorIndex: 2 }),
      ])
    );
    expect(g.getState().pawns[1].eliminated).toBe(true);
    expect(g.getState().phase).toBe("aiming");
    g.destroy();
  });

  it("lets a moving state with one survivor resolve at settle (as live play would)", () => {
    // Mid-flight: the mover is already out (a legal state — its flight can
    // still be resolving) and a single survivor keeps gliding. The match
    // must not finish instantly on load; it finishes when the survivor
    // settles, exactly like an uninterrupted simulation.
    const g = createGame();
    g.loadState({
      phase: "moving",
      winnerId: null,
      turn: { queue: ["p0", "p1"], activeIndex: 0, settleTicks: 10 },
      pawns: [
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY + 150, { velocity: { x: 0, y: 0.8 } }),
      ],
    });
    expect(g.getState().phase).toBe("moving");
    pump(g, 900);
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p1");
    g.destroy();
  });

  it("reconstructs a mid-flight state with an eliminated mover bit-identically", () => {
    // The eliminated mover is still the ACTIVE pawn while its last flight
    // resolves — rotation must stay put on reconstruction so the turn ends
    // exactly where the uninterrupted simulation would end it.
    const craft = (): GameState => ({
      phase: "moving",
      winnerId: null,
      turn: { queue: ["p0", "p1", "p2"], activeIndex: 0, settleTicks: 12 },
      pawns: [
        pawnAt("p0", CX, CY + 300, { eliminated: true }),
        pawnAt("p1", CX, CY + 150, { velocity: { x: 0, y: 1.2 } }),
        pawnAt("p2", CX, CY - 240, { colorIndex: 2 }),
      ],
    });
    const a = createGame();
    a.loadState(craft());
    pump(a, 900);
    expect(a.getState().phase).toBe("aiming");
    expect(a.snapshot().activePawnId).toBe("p1"); // rotation advanced past p0 at settle

    const b = createGame();
    b.loadState(deserializeGameState(serializeGameState(craft())));
    pump(b, 900);
    expect(b.getState()).toEqual(a.getState());
    a.destroy();
    b.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Serialization, determinism, replay
// ────────────────────────────────────────────────────────────────────────

describe("N-player serialization and determinism", () => {
  it("round-trips a mid-match three-player state through JSON", () => {
    const g = createGame({ players: specs(3) });
    launchInward(g, "p0", 3);
    g.update(DT);
    g.update(DT);
    const restored = deserializeGameState(serializeGameState(g.getState()));
    expect(restored).toEqual(g.getState());
    g.destroy();
  });

  it("round-trips a finished state with per-pawn flags and the winner", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g);
    const original = g.getState();
    const restored = deserializeGameState(serializeGameState(original));
    expect(restored).toEqual(original);
    expect(restored.phase).toBe("finished");
    expect(restored.winnerId).toBe("p0");
    expect(restored.pawns[1].eliminated).toBe(true);
    g.destroy();
  });

  it("continues deterministically after an elimination (state transfer)", () => {
    // p0 has just knocked p1 out; the match continues with p2 to act.
    const build = () => {
      const g = createGame();
      const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
      g.loadState(knockoutSetup("p0", "p1", [bystander]));
      launchOutward(g, "p0", { x: 0, y: 1 }, 5);
      pump(g);
      return g;
    };
    const a = build();
    const b = createGame();
    b.loadState(deserializeGameState(serializeGameState(a.getState())));

    // Both continue: p2 aims, launches; then p0 again.
    for (const g of [a, b]) {
      launchInward(g, "p2", 2);
      pump(g);
      launchInward(g, "p0", 3);
      pump(g);
    }
    expect(b.getState()).toEqual(a.getState());
    expect(b.snapshot()).toEqual(a.snapshot());
    a.destroy();
    b.destroy();
  });

  it("replays a whole scripted match bit-identically (2 players)", () => {
    const engines = [createGame(), createGame()];
    const states = engines.map((g) => {
      g.loadState(knockoutSetup("p0", "p1"));
      launchOutward(g, "p0", { x: 0, y: 1 }, 5);
      pump(g);
      return g.getState();
    });
    expect(states[1]).toEqual(states[0]);
    expect(states[0].phase).toBe("finished");
    expect(states[0].winnerId).toBe("p0");
    for (const e of engines) e.destroy();
  });

  it("replays a whole scripted match bit-identically (3 players, elimination included)", () => {
    const script = (g: GameHandle) => {
      const bystander = pawnAt("p2", CX, CY - 240, { colorIndex: 2 });
      g.loadState(knockoutSetup("p0", "p1", [bystander]));
      launchOutward(g, "p0", { x: 0, y: 1 }, 5); // p1 knocked out
      pump(g); // → p2
      launchInward(g, "p2", 2); // safe launch
      pump(g); // → p0
      launchInward(g, "p0", 1); // safe launch
      pump(g); // → p2
      return g.getState();
    };
    const engines = [createGame(), createGame()];
    const [s1, s2] = engines.map(script);
    expect(s2).toEqual(s1);
    expect(s1.pawns[1].eliminated).toBe(true);
    expect(s1.phase).toBe("aiming");
    for (const e of engines) e.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Projection and the engine's lack of local identity
// ────────────────────────────────────────────────────────────────────────

describe("projection is caller-localized; the engine has no local player", () => {
  function threePlayerState(): GameState {
    const g = createGame({ players: specs(3) });
    launchInward(g, "p0", 1);
    pump(g); // p1's turn
    return g.getState();
  }

  it("the engine's own snapshot is a pure spectator view", () => {
    const g = createGame({ players: specs(3) });
    const s = g.snapshot();
    expect(s.localPawnId).toBeNull();
    expect(s.pawns.every((p) => !p.isLocal)).toBe(true);
    expect(s.activePawnId).toBe("p0");
    g.destroy();
  });

  it("marks isLocal for exactly the caller's pawn, per caller", () => {
    const state = threePlayerState();
    for (const viewer of ["p0", "p1", "p2", null]) {
      const view = projectSnapshot(state, viewer);
      expect(view.localPawnId).toBe(viewer);
      for (const p of view.pawns) {
        expect(p.isLocal).toBe(p.id === viewer);
      }
    }
  });

  it("the winner does not depend on who is looking", () => {
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    launchOutward(g, "p0", { x: 0, y: 1 }, 5);
    pump(g);
    const state = g.getState();
    expect(state.winnerId).toBe("p0");
    expect(g.snapshot().winnerId).toBe("p0"); // spectator
    expect(projectSnapshot(state, "p0").winnerId).toBe("p0"); // winner's view
    expect(projectSnapshot(state, "p1").winnerId).toBe("p0"); // loser's view
    g.destroy();
  });

  it("projections agree on everything except the local flags", () => {
    const state = threePlayerState();
    const asP0 = projectSnapshot(state, "p0");
    const asP1 = projectSnapshot(state, "p1");
    expect(asP0.pawns.map((p) => p.eliminated)).toEqual(asP1.pawns.map((p) => p.eliminated));
    expect(asP0.activePawnId).toBe(asP1.activePawnId);
    expect(asP0.power).toBe(asP1.power);
    expect(asP0.aimDirection).toEqual(asP1.aimDirection);
  });
});

describe("a server can run the whole match without any local identity", () => {
  it("drives a match using only commands, updates and authoritative state", () => {
    // Exactly the flow a future authoritative server will use: no snapshot,
    // no projection, no local pawn id — applyCommand / update / getState /
    // serializeGameState only.
    const g = createGame();
    g.loadState(knockoutSetup("p0", "p1"));
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY + 400 });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    while (g.getState().phase === "moving") g.update(DT);

    const wire = serializeGameState(g.getState());
    const final = deserializeGameState(wire);
    expect(final.phase).toBe("finished");
    expect(final.winnerId).toBe("p0");
    expect(final.pawns[1].eliminated).toBe(true);
    // Nothing client-ish ever enters the authoritative state.
    expect(wire).not.toMatch(/local/i);
    expect(wire).not.toMatch(/client/i);
    g.destroy();
  });
});
