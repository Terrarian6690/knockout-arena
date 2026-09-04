import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { createGame } from "../game";
import {
  deserializeGameState,
  serializeGameState,
  validateGameState,
  type GameState,
  type PawnState,
} from "../state";
import { projectSnapshot } from "../project";

const DT = CONFIG.simulation.fixedTimestepMs;

/**
 * UPDATED for the simultaneous-round state schema:
 *   - aim + power live on EACH pawn (per-player controls; power persists
 *     across rounds, aim resets per round);
 *   - per-pawn `confirmed` — locked in the current round's move;
 *   - `round.settleTicks` replaces the whole turn queue (there is NO
 *     current player and NO rotation — rounds are simultaneous);
 *   - `winnerId` field (set only in the "finished" phase);
 *   - the phase union is aiming | moving | finished (elimination is a
 *     per-pawn flag, not a phase).
 */

/** Build a complete, valid state by hand (single pawn at spawn). */
function handmadeState(): GameState {
  return {
    phase: "aiming",
    winnerId: null,
    round: { settleTicks: 0 },
    pawns: [handmadePawn("p0", "Player 1", 0, 450, 110)],
  };
}

function handmadePawn(
  id: string,
  name: string,
  colorIndex: number,
  x: number,
  y: number
): PawnState {
  return {
    id,
    name,
    colorIndex,
    radius: CONFIG.pawn.radius,
    spawnX: x,
    spawnY: y,
    eliminated: false,
    power: CONFIG.power.default,
    confirmed: false,
    aim: { active: false, direction: { x: 0, y: -1 } },
    lastLaunch: null,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
  };
}

describe("validateGameState — valid states", () => {
  it("accepts a hand-made state", () => {
    expect(() => validateGameState(handmadeState())).not.toThrow();
  });

  it("accepts engine-produced states in every phase", () => {
    const g = createGame();
    // aiming
    expect(() => validateGameState(g.getState())).not.toThrow();
    // moving (mid-flight)
    g.dispatch({ type: "aim", playerId: "p0", x: 450, y: 400 });
    g.dispatch({ type: "setPower", playerId: "p0", power: 4 });
    g.dispatch({ type: "confirmLaunch", playerId: "p0" });
    g.update(DT);
    g.update(DT);
    expect(g.getState().phase).toBe("moving");
    expect(() => validateGameState(g.getState())).not.toThrow();
    // finished (single pawn flying out ends the match with no survivor)
    const h = createGame();
    h.dispatch({ type: "setPower", playerId: "p0", power: 5 });
    h.dispatch({ type: "confirmLaunch", playerId: "p0" });
    for (let i = 0; i < 200 && h.snapshot().phase === "moving"; i++) h.update(DT);
    expect(h.getState().phase).toBe("finished");
    expect(h.getState().winnerId).toBeNull();
    expect(() => validateGameState(h.getState())).not.toThrow();
    g.destroy();
    h.destroy();
  });

  it("accepts a multi-pawn state (the N-player schema)", () => {
    const s = handmadeState();
    s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
    s.round = { settleTicks: 3 };
    expect(() => validateGameState(s)).not.toThrow();
  });

  it("accepts confirmed pawns during the aiming phase", () => {
    const s = handmadeState();
    s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
    s.pawns[0].confirmed = true;
    s.pawns[1].confirmed = true;
    expect(() => validateGameState(s)).not.toThrow();
  });

  it("accepts a mid-round state with settle ticks", () => {
    const s = handmadeState();
    s.phase = "moving";
    s.round = { settleTicks: 17 };
    expect(() => validateGameState(s)).not.toThrow();
  });

  it("accepts a finished state with a surviving winner", () => {
    const s = handmadeState();
    s.pawns.push({ ...handmadePawn("p1", "Player 2", 1, 450, 590), eliminated: true });
    s.phase = "finished";
    s.winnerId = "p0";
    expect(() => validateGameState(s)).not.toThrow();
  });
});

describe("validateGameState — rejects corrupted states", () => {
  const corrupt = (mutate: (s: GameState) => void) => {
    const s = handmadeState();
    mutate(s);
    return s;
  };

  it("rejects non-objects", () => {
    for (const bad of [null, undefined, 42, "state", []]) {
      expect(() => validateGameState(bad)).toThrow(/not an object/);
    }
  });

  it("rejects unknown phases", () => {
    expect(() =>
      validateGameState(corrupt((s) => ((s.phase as string) = "gameOver")))
    ).toThrow(/invalid phase/);
    // The retired single-player phase is no longer part of the schema.
    expect(() =>
      validateGameState(corrupt((s) => ((s.phase as string) = "eliminated")))
    ).toThrow(/invalid phase/);
  });

  it("rejects a winner while the match is not finished", () => {
    expect(() =>
      validateGameState(corrupt((s) => (s.winnerId = "p0")))
    ).toThrow(/not finished/);
  });

  it("rejects a winner that does not exist", () => {
    expect(() =>
      validateGameState(
        corrupt((s) => {
          s.phase = "finished";
          s.winnerId = "ghost";
        })
      )
    ).toThrow(/unknown pawn/);
  });

  it("rejects an eliminated pawn as the winner", () => {
    expect(() =>
      validateGameState(
        corrupt((s) => {
          s.pawns[0].eliminated = true;
          s.phase = "finished";
          s.winnerId = "p0";
        })
      )
    ).toThrow(/eliminated pawn/);
  });

  it("rejects a non-string winnerId", () => {
    expect(() =>
      validateGameState(corrupt((s) => ((s.winnerId as unknown as number) = 3)))
    ).toThrow(/winnerId/);
  });

  it("rejects malformed per-pawn power", () => {
    expect(() =>
      validateGameState(corrupt((s) => ((s.pawns[0].power as unknown as string) = "3")))
    ).toThrow(/power/);
    expect(() => validateGameState(corrupt((s) => (s.pawns[0].power = 0)))).toThrow(/power/);
    expect(() => validateGameState(corrupt((s) => (s.pawns[0].power = 6)))).toThrow(/power/);
    expect(() => validateGameState(corrupt((s) => (s.pawns[0].power = 2.5)))).toThrow(/power/);
  });

  it("rejects malformed per-pawn aim", () => {
    // Sanity: the untouched hand-made state is valid.
    expect(() => validateGameState(handmadeState())).not.toThrow();
    expect(() =>
      validateGameState(
        corrupt((s) => ((s.pawns[0].aim.active as unknown as string) = "yes"))
      )
    ).toThrow(/aim\.active/);
    expect(() =>
      validateGameState(
        corrupt((s) => ((s.pawns[0].aim.direction.x as unknown as string) = "NaN"))
      )
    ).toThrow(/aim\.direction/);
    expect(() =>
      validateGameState(corrupt((s) => (s.pawns[0].aim.direction = { x: 3, y: 4 })))
    ).toThrow(/unit vector/);
    expect(() =>
      validateGameState(corrupt((s) => ((s.pawns[0].aim as unknown as null) = null)))
    ).toThrow(/aim/);
  });

  it("rejects malformed round state", () => {
    expect(() =>
      validateGameState(corrupt((s) => ((s.round as unknown as null) = null)))
    ).toThrow(/missing round/);
    expect(() =>
      validateGameState(corrupt((s) => (s.round.settleTicks = -1)))
    ).toThrow(/settleTicks/);
    expect(() =>
      validateGameState(corrupt((s) => (s.round.settleTicks = 1.5)))
    ).toThrow(/settleTicks/);
    expect(() =>
      validateGameState(corrupt((s) => ((s.round.settleTicks as unknown as string) = "3")))
    ).toThrow(/settleTicks/);
  });

  it("rejects a non-boolean confirmed flag", () => {
    expect(() =>
      validateGameState(
        corrupt((s) => ((s.pawns[0].confirmed as unknown as string) = "yes"))
      )
    ).toThrow(/confirmed/);
  });

  it("rejects an eliminated pawn that is confirmed", () => {
    // Reason: an eliminated pawn cannot participate in any round; keeping
    // the invariant explicit makes the flag trustworthy after restore.
    expect(() =>
      validateGameState(
        corrupt((s) => {
          s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
          s.pawns[0].eliminated = true;
          s.pawns[0].confirmed = true;
        })
      )
    ).toThrow(/eliminated pawn .* must not be confirmed/);
  });

  it("rejects malformed pawns", () => {
    expect(() =>
      validateGameState(corrupt((s) => ((s.pawns[0].id as unknown as number) = 5)))
    ).toThrow(/pawn\.id/);
    expect(() =>
      validateGameState(corrupt((s) => ((s.pawns[0].eliminated as unknown as string) = "no")))
    ).toThrow(/eliminated/);
    expect(() =>
      validateGameState(corrupt((s) => (s.pawns[0].position = { x: NaN, y: 0 } as never)))
    ).toThrow(/position/);
    expect(() =>
      validateGameState(corrupt((s) => (s.pawns[0].radius = 0)))
    ).toThrow(/radius/);
    expect(() =>
      validateGameState(corrupt((s) => (s.pawns = [] as never)))
    ).toThrow(/pawns/);
  });

  it("rejects duplicate pawn ids", () => {
    expect(() =>
      validateGameState(corrupt((s) => s.pawns.push({ ...s.pawns[0] })))
    ).toThrow(/duplicate/);
  });
});

describe("serializeGameState / deserializeGameState", () => {
  it("round-trips an engine state through JSON losslessly", () => {
    const g = createGame();
    g.dispatch({ type: "aim", playerId: "p0", x: 500, y: 300 });
    g.dispatch({ type: "setPower", playerId: "p0", power: 2 });
    const original = g.getState();
    const restored = deserializeGameState(serializeGameState(original));
    expect(restored).toEqual(original);
    g.destroy();
  });

  it("round-trips a mid-flight state", () => {
    const g = createGame();
    g.dispatch({ type: "aim", playerId: "p0", x: 450, y: 400 });
    g.dispatch({ type: "setPower", playerId: "p0", power: 5 });
    g.dispatch({ type: "confirmLaunch", playerId: "p0" });
    for (let i = 0; i < 25; i++) g.update(DT);
    const restored = deserializeGameState(serializeGameState(g.getState()));
    expect(restored).toEqual(g.getState());
    g.destroy();
  });

  it("round-trips a finished state with its winner", () => {
    const g = createGame();
    g.dispatch({ type: "setPower", playerId: "p0", power: 5 });
    g.dispatch({ type: "confirmLaunch", playerId: "p0" });
    for (let i = 0; i < 200 && g.snapshot().phase === "moving"; i++) g.update(DT);
    const restored = deserializeGameState(serializeGameState(g.getState()));
    expect(restored.phase).toBe("finished");
    expect(restored.winnerId).toBeNull();
    expect(restored).toEqual(g.getState());
    g.destroy();
  });

  it("rejects invalid JSON strings", () => {
    expect(() => deserializeGameState("{not json")).toThrow(/invalid JSON/);
  });

  it("rejects valid JSON that is not a valid state", () => {
    expect(() => deserializeGameState('{"phase":"winning"}')).toThrow(/invalid phase/);
    expect(() => deserializeGameState("42")).toThrow(/not an object/);
    expect(() => deserializeGameState("null")).toThrow(/not an object/);
  });
});

describe("projectSnapshot (state → client view)", () => {
  it("projects aiming state with the viewer's own aim visible", () => {
    const s = handmadeState();
    s.pawns[0].aim.active = true;
    s.pawns[0].aim.direction = { x: 0, y: 1 };
    const view = projectSnapshot(s, "p0");
    expect(view.phase).toBe("aiming");
    expect(view.isAiming).toBe(true);
    expect(view.aimDirection).toEqual({ x: 0, y: 1 });
    expect(view.localPawnId).toBe("p0");
    expect(view.pawns[0].confirmed).toBe(false);
    expect(view.pawns[0].isLocal).toBe(true);
  });

  it("projects each pawn's round confirmation per pawn", () => {
    const s = handmadeState();
    s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
    s.pawns[0].confirmed = true;
    s.pawns[1].confirmed = false;
    const view = projectSnapshot(s, null);
    expect(view.pawns.find((p) => p.id === "p0")!.confirmed).toBe(true);
    expect(view.pawns.find((p) => p.id === "p1")!.confirmed).toBe(false);
    expect(view.localPawnId).toBeNull();
  });

  it("hides the aim while the round resolves even if aim.active is somehow true", () => {
    const s = handmadeState();
    s.phase = "moving";
    s.pawns[0].aim.active = true;
    const view = projectSnapshot(s, "p0");
    expect(view.isAiming).toBe(false);
  });

  it("hides the aim of an eliminated viewer", () => {
    const s = handmadeState();
    s.phase = "aiming";
    s.pawns[0].eliminated = true;
    s.pawns[0].aim.active = true;
    const view = projectSnapshot(s, "p0");
    expect(view.isAiming).toBe(false);
  });

  it("marks isLocal per pawn and only for the caller's own pawn", () => {
    const s = handmadeState();
    s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
    const asP0 = projectSnapshot(s, "p0");
    expect(asP0.pawns.find((p) => p.id === "p0")!.isLocal).toBe(true);
    expect(asP0.pawns.find((p) => p.id === "p1")!.isLocal).toBe(false);
    const asP1 = projectSnapshot(s, "p1");
    expect(asP1.pawns.find((p) => p.id === "p0")!.isLocal).toBe(false);
    expect(asP1.pawns.find((p) => p.id === "p1")!.isLocal).toBe(true);
    const asSpectator = projectSnapshot(s, null);
    expect(asSpectator.pawns.every((p) => !p.isLocal)).toBe(true);
  });

  it("projects the VIEWER'S OWN controls (simultaneous rounds)", () => {
    const s = handmadeState();
    s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
    s.pawns[0].power = 5;
    s.pawns[0].aim = { active: true, direction: { x: 1, y: 0 } };
    s.pawns[1].power = 2;
    s.pawns[1].aim = { active: true, direction: { x: 0, y: -1 } };
    // Each player sees their OWN selection — not "the active pawn's".
    const asP0 = projectSnapshot(s, "p0");
    expect(asP0.power).toBe(5);
    expect(asP0.aimDirection).toEqual({ x: 1, y: 0 });
    const asP1 = projectSnapshot(s, "p1");
    expect(asP1.power).toBe(2);
    expect(asP1.aimDirection).toEqual({ x: 0, y: -1 });
  });

  it("projects neutral spectator controls (no local pawn)", () => {
    const s = handmadeState();
    s.pawns.push(handmadePawn("p1", "Player 2", 1, 450, 590));
    s.pawns[0].power = 5;
    s.pawns[0].aim = { active: true, direction: { x: 1, y: 0 } };
    const view = projectSnapshot(s, null);
    expect(view.power).toBe(CONFIG.power.default);
    expect(view.aimDirection).toBeNull();
    expect(view.isAiming).toBe(false);
  });

  it("carries the winner through the projection", () => {
    const s = handmadeState();
    s.phase = "finished";
    s.winnerId = "p0";
    const view = projectSnapshot(s, "p0");
    expect(view.phase).toBe("finished");
    expect(view.winnerId).toBe("p0");
  });

  it("matches the engine's own snapshot for a live game", () => {
    // UPDATED: the engine's snapshot() is now the SPECTATOR projection (the
    // engine has no local player), so the equality holds for localPawnId
    // null. Localizing is the client's job (see useGame).
    const g = createGame();
    g.dispatch({ type: "aim", playerId: "p0", x: 500, y: 300 });
    expect(projectSnapshot(g.getState(), null)).toEqual(g.snapshot());
    g.destroy();
  });
});
