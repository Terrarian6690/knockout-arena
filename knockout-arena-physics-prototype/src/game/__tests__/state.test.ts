import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { createGame } from "../game";
import {
  deserializeGameState,
  serializeGameState,
  validateGameState,
  type GameState,
} from "../state";
import { projectSnapshot } from "../project";

const DT = CONFIG.simulation.fixedTimestepMs;

/** Build a complete, valid state by hand (single pawn at spawn). */
function handmadeState(): GameState {
  return {
    phase: "aiming",
    power: 3,
    aim: { active: false, direction: { x: 0, y: -1 } },
    turn: { queue: ["p0"], activeIndex: 0, settleTicks: 0 },
    pawns: [
      {
        id: "p0",
        name: "Player 1",
        colorIndex: 0,
        radius: CONFIG.pawn.radius,
        spawnX: 450,
        spawnY: 110,
        eliminated: false,
        position: { x: 450, y: 110 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        angularVelocity: 0,
      },
    ],
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
    g.dispatch({ type: "aim", x: 450, y: 400 });
    g.dispatch({ type: "setPower", power: 4 });
    g.dispatch({ type: "confirmLaunch" });
    g.update(DT);
    g.update(DT);
    expect(g.getState().phase).toBe("moving");
    expect(() => validateGameState(g.getState())).not.toThrow();
    // eliminated
    const h = createGame();
    h.dispatch({ type: "setPower", power: 5 });
    h.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 200 && h.snapshot().phase === "moving"; i++) h.update(DT);
    expect(h.getState().phase).toBe("eliminated");
    expect(() => validateGameState(h.getState())).not.toThrow();
    g.destroy();
    h.destroy();
  });

  it("accepts a multi-pawn state (future-proofing)", () => {
    const s = handmadeState();
    s.pawns.push({
      ...s.pawns[0],
      id: "p1",
      name: "Player 2",
      colorIndex: 1,
      spawnX: 450,
      spawnY: 590,
      position: { x: 450, y: 590 },
    });
    s.turn = { queue: ["p0", "p1"], activeIndex: 1, settleTicks: 3 };
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
  });

  it("rejects non-numeric power", () => {
    expect(() =>
      validateGameState(corrupt((s) => ((s.power as unknown as string) = "3")))
    ).toThrow(/power/);
  });

  it("rejects malformed aim", () => {
    // Sanity: the untouched hand-made state is valid.
    expect(() => validateGameState(handmadeState())).not.toThrow();
    expect(() =>
      validateGameState(corrupt((s) => ((s.aim.active as unknown as string) = "yes")))
    ).toThrow(/aim\.active/);
    expect(() =>
      validateGameState(corrupt((s) => ((s.aim.direction.x as unknown as string) = "NaN")))
    ).toThrow(/aim\.direction/);
    expect(() =>
      validateGameState(corrupt((s) => (s.aim.direction = { x: 3, y: 4 })))
    ).toThrow(/unit vector/);
  });

  it("rejects malformed turn state", () => {
    expect(() =>
      validateGameState(corrupt((s) => (s.turn = { queue: [], activeIndex: 0, settleTicks: 0 } as never)))
    ).toThrow(/turn\.queue/);
    expect(() =>
      validateGameState(corrupt((s) => (s.turn.activeIndex = 7)))
    ).toThrow(/activeIndex/);
    expect(() =>
      validateGameState(corrupt((s) => (s.turn.settleTicks = -1)))
    ).toThrow(/settleTicks/);
    expect(() =>
      validateGameState(corrupt((s) => (s.turn.queue = ["p0", "ghost"])))
    ).toThrow(/unknown pawn/);
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
    g.dispatch({ type: "aim", x: 500, y: 300 });
    g.dispatch({ type: "setPower", power: 2 });
    const original = g.getState();
    const restored = deserializeGameState(serializeGameState(original));
    expect(restored).toEqual(original);
    g.destroy();
  });

  it("round-trips a mid-flight state", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 450, y: 400 });
    g.dispatch({ type: "setPower", power: 5 });
    g.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 25; i++) g.update(DT);
    const restored = deserializeGameState(serializeGameState(g.getState()));
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
  it("projects aiming state with the aim visible", () => {
    const s = handmadeState();
    s.aim.active = true;
    s.aim.direction = { x: 0, y: 1 };
    const view = projectSnapshot(s, "p0");
    expect(view.phase).toBe("aiming");
    expect(view.isAiming).toBe(true);
    expect(view.aimDirection).toEqual({ x: 0, y: 1 });
    expect(view.localPawnId).toBe("p0");
    expect(view.activePawnId).toBe("p0");
    expect(view.pawns[0].isMoving).toBe(false);
  });

  it("projects moving state with the active pawn moving", () => {
    const s = handmadeState();
    s.phase = "moving";
    s.aim.active = false;
    const view = projectSnapshot(s, "p0");
    expect(view.isAiming).toBe(false);
    expect(view.aimDirection).toBeNull();
    expect(view.pawns[0].isMoving).toBe(true);
  });

  it("hides the aim while moving even if aim.active is somehow true", () => {
    const s = handmadeState();
    s.phase = "moving";
    s.aim.active = true;
    const view = projectSnapshot(s, "p0");
    expect(view.isAiming).toBe(false);
  });

  it("marks only the active pawn as moving in a multi-pawn state", () => {
    const s = handmadeState();
    s.phase = "moving";
    s.pawns.push({ ...s.pawns[0], id: "p1", position: { x: 450, y: 590 } });
    s.turn = { queue: ["p0", "p1"], activeIndex: 1, settleTicks: 0 };
    const view = projectSnapshot(s, null);
    expect(view.pawns.find((p) => p.id === "p0")!.isMoving).toBe(false);
    expect(view.pawns.find((p) => p.id === "p1")!.isMoving).toBe(true);
    expect(view.localPawnId).toBeNull();
  });

  it("matches the engine's own snapshot for a live game", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 500, y: 300 });
    expect(projectSnapshot(g.getState(), "p0")).toEqual(g.snapshot());
    g.destroy();
  });
});
