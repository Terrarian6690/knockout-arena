import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { createGame } from "../game";
import type { GameCommand } from "../commands";
import {
  serializeGameState,
  deserializeGameState,
  type GameState,
} from "../state";

const DT = CONFIG.simulation.fixedTimestepMs;
const FLOOR = CONFIG.arena.radius - CONFIG.arena.wallThickness;
const PAWN_R = CONFIG.pawn.radius;

/** Drive the game loop until the phase leaves "moving" (or maxFrames). */
function pump(g: ReturnType<typeof createGame>, maxFrames: number): number {
  for (let i = 0; i < maxFrames; i++) {
    g.update(DT);
    if (g.snapshot().phase !== "moving") return i + 1;
  }
  return maxFrames;
}

describe("getState — serializable authoritative state", () => {
  it("returns plain JSON data (no functions, no Matter internals)", () => {
    const g = createGame();
    const state = g.getState();
    // If anything non-JSON lived in the state, the round-trip would lose it.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(serializeGameState(state)).toBeTypeOf("string");
    g.destroy();
  });

  it("contains everything needed for reconstruction", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 500, y: 300 });
    g.dispatch({ type: "setPower", power: 4 });
    g.dispatch({ type: "confirmLaunch" });
    g.update(DT);
    const s = g.getState();

    expect(s.phase).toBe("moving");
    expect(s.power).toBe(4);
    expect(s.turn.queue).toEqual(["p0"]);
    expect(s.turn.settleTicks).toBe(1);
    const pawn = s.pawns[0];
    // Kinematics present so physics can be rebuilt.
    expect(pawn.position.x).toBeTypeOf("number");
    expect(pawn.velocity.y).toBeGreaterThan(0);
    expect(pawn.angle).toBeTypeOf("number");
    expect(pawn.angularVelocity).toBeTypeOf("number");
    // Domain data present so the player model can be rebuilt.
    expect(pawn.spawnX).toBe(450);
    expect(pawn.name).toBe("Player 1");
    g.destroy();
  });
});

describe("loadState — reconstruction", () => {
  it("reproduces the exact snapshot after a state transfer", () => {
    const a = createGame();
    a.dispatch({ type: "aim", x: 500, y: 300 });
    a.dispatch({ type: "setPower", power: 3 });
    a.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 20; i++) a.update(DT);

    const b = createGame();
    b.loadState(a.getState());
    expect(b.snapshot()).toEqual(a.snapshot());
    a.destroy();
    b.destroy();
  });

  it("reproduces snapshots through a JSON wire", () => {
    const a = createGame();
    a.dispatch({ type: "aim", x: 450, y: 40 });
    a.dispatch({ type: "setPower", power: 5 });
    a.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 15; i++) a.update(DT);

    const b = createGame();
    b.loadState(deserializeGameState(serializeGameState(a.getState())));
    expect(b.snapshot()).toEqual(a.snapshot());
    a.destroy();
    b.destroy();
  });

  it("reconstructs every phase", () => {
    // Aiming with an active aim.
    const aiming = createGame();
    aiming.dispatch({ type: "aim", x: 500, y: 300 });
    const b1 = createGame();
    b1.loadState(aiming.getState());
    expect(b1.snapshot()).toEqual(aiming.snapshot());
    b1.destroy();
    aiming.destroy();

    // Moving, mid-flight.
    const moving = createGame();
    moving.dispatch({ type: "aim", x: 450, y: 400 });
    moving.dispatch({ type: "setPower", power: 5 });
    moving.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 33; i++) moving.update(DT);
    expect(moving.getState().phase).toBe("moving");
    const b2 = createGame();
    b2.loadState(moving.getState());
    expect(b2.snapshot()).toEqual(moving.snapshot());
    b2.destroy();
    moving.destroy();

    // Eliminated.
    const eliminated = createGame();
    eliminated.dispatch({ type: "setPower", power: 5 });
    eliminated.dispatch({ type: "confirmLaunch" });
    pump(eliminated, 700);
    expect(eliminated.getState().phase).toBe("eliminated");
    const b3 = createGame();
    b3.loadState(eliminated.getState());
    expect(b3.snapshot()).toEqual(eliminated.snapshot());
    b3.destroy();
    eliminated.destroy();
  });

  it("throws on malformed state (trust boundary)", () => {
    const g = createGame();
    const before = g.getState();
    for (const bad of [null, {}, { phase: "winning" }, [], 42, "state"]) {
      expect(() => g.loadState(bad as GameState)).toThrow();
    }
    // Failed loads leave the engine untouched.
    expect(g.getState()).toEqual(before);
    // A valid state loads fine.
    expect(() => g.loadState(before)).not.toThrow();
    g.destroy();
  });

  it("continues deterministically after reconstruction (the core guarantee)", () => {
    // Original run.
    const a = createGame();
    a.dispatch({ type: "aim", x: 460, y: 380 });
    a.dispatch({ type: "setPower", power: 4 });
    a.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 40; i++) a.update(DT); // mid-flight
    const checkpoint = a.getState();

    // Transfer into a fresh engine (via JSON, like a future server would).
    const b = createGame();
    b.loadState(deserializeGameState(serializeGameState(checkpoint)));

    // Continue both with identical frame deltas.
    const traceA: number[] = [];
    const traceB: number[] = [];
    for (let i = 0; i < 200; i++) {
      a.update(DT);
      b.update(DT);
      const pa = a.snapshot().pawns[0].position;
      const pb = b.snapshot().pawns[0].position;
      traceA.push(pa.x, pa.y);
      traceB.push(pb.x, pb.y);
    }
    expect(traceB).toEqual(traceA);
    expect(b.getState()).toEqual(a.getState()); // same settle tick, same phase
    a.destroy();
    b.destroy();
  });

  it("continues deterministically from an elimination checkpoint", () => {
    const a = createGame();
    a.dispatch({ type: "aim", x: 450, y: 40 });
    a.dispatch({ type: "setPower", power: 5 });
    a.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 5; i++) a.update(DT); // just after launch, heading out

    const b = createGame();
    b.loadState(a.getState());
    pump(a, 700);
    pump(b, 700);
    expect(b.getState()).toEqual(a.getState());
    expect(b.snapshot().phase).toBe("eliminated");
    a.destroy();
    b.destroy();
  });

  it("supports continued play from a reconstructed aiming state", () => {
    const a = createGame();
    a.dispatch({ type: "aim", x: 450, y: 400 });
    a.dispatch({ type: "setPower", power: 2 });
    a.dispatch({ type: "confirmLaunch" });
    pump(a, 700); // settled somewhere mid-arena

    const b = createGame();
    b.loadState(a.getState());
    // Both continue with the same scripted commands.
    for (const g of [a, b]) {
      g.dispatch({ type: "aim", x: 500, y: 350 });
      g.dispatch({ type: "setPower", power: 3 });
      g.dispatch({ type: "confirmLaunch" });
    }
    for (let i = 0; i < 300; i++) {
      a.update(DT);
      b.update(DT);
    }
    expect(b.snapshot()).toEqual(a.snapshot());
    a.destroy();
    b.destroy();
  });
});

describe("loadState — state-driven engine (multi-pawn future-proofing)", () => {
  it("adopts a two-pawn state and rotates turns correctly", () => {
    const g = createGame();
    const base = g.getState();

    // Craft a two-pawn state: second pawn at the bottom of the arena.
    const twoPawn: GameState = {
      ...base,
      turn: { queue: ["p0", "p1"], activeIndex: 0, settleTicks: 0 },
      pawns: [
        base.pawns[0],
        {
          ...base.pawns[0],
          id: "p1",
          name: "Player 2",
          colorIndex: 1,
          spawnX: 450,
          spawnY: 590,
          position: { x: 450, y: 590 },
        },
      ],
    };
    g.loadState(twoPawn);
    expect(g.snapshot().pawns.length).toBe(2);
    expect(g.snapshot().activePawnId).toBe("p0");

    // p0 launches toward the center and settles → turn advances to p1.
    g.dispatch({ type: "aim", x: 450, y: 350 });
    g.dispatch({ type: "setPower", power: 2 });
    g.dispatch({ type: "confirmLaunch" });
    pump(g, 700);
    expect(g.snapshot().phase).toBe("aiming");
    expect(g.snapshot().activePawnId).toBe("p1");

    // p1 launches as well → turn wraps back to p0.
    g.dispatch({ type: "aim", x: 450, y: 350 });
    g.dispatch({ type: "setPower", power: 1 });
    g.dispatch({ type: "confirmLaunch" });
    pump(g, 700);
    expect(g.snapshot().activePawnId).toBe("p0");
    g.destroy();
  });

  it("removes bodies for pawns that disappear from the state", () => {
    const g = createGame();
    const base = g.getState();
    const single: GameState = {
      ...base,
      pawns: [
        { ...base.pawns[0], id: "solo", name: "Solo" },
      ],
      turn: { queue: ["solo"], activeIndex: 0, settleTicks: 0 },
    };
    g.loadState(single);
    expect(g.snapshot().pawns.map((p) => p.id)).toEqual(["solo"]);
    // The old p0 body must be gone (the engine's world only has the new pawn).
    expect(g.getState().pawns.length).toBe(1);
    g.destroy();
  });

  it("reset works from a loaded multi-pawn state", () => {
    const g = createGame();
    const base = g.getState();
    g.loadState({
      ...base,
      turn: { queue: ["p0", "p1"], activeIndex: 1, settleTicks: 5 },
      pawns: [
        base.pawns[0],
        { ...base.pawns[0], id: "p1", colorIndex: 1, spawnX: 450, spawnY: 590, position: { x: 450, y: 590 } },
      ],
    });
    g.dispatch({ type: "reset" });
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    expect(s.activePawnId).toBe("p0");
    expect(s.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 450, y: 590 });
    g.destroy();
  });
});

describe("engine behavior is unchanged by the architecture", () => {
  it("state round-trip preserves rim pass-over semantics", () => {
    // Mid fly-over: the pawn is past the rim with walls disabled. After a
    // state transfer the reconstructed engine must still eliminate it (the
    // pass-over decision is re-derived from position + velocity each tick).
    const a = createGame();
    a.dispatch({ type: "aim", x: 450, y: 40 });
    a.dispatch({ type: "setPower", power: 5 });
    a.dispatch({ type: "confirmLaunch" });
    // Find the tick where the pawn is past the rim contact circle.
    let checkpoint: GameState | null = null;
    for (let i = 0; i < 60; i++) {
      a.update(DT);
      const p = a.snapshot().pawns[0].position;
      const dist = Math.hypot(p.x - CONFIG.arena.centerX, p.y - CONFIG.arena.centerY);
      if (dist > FLOOR - PAWN_R + 1 && dist < FLOOR + PAWN_R) {
        checkpoint = a.getState(); // mid-fly-over
        break;
      }
    }
    expect(checkpoint).not.toBeNull();

    const b = createGame();
    b.loadState(checkpoint!);
    pump(b, 200);
    expect(b.snapshot().phase).toBe("eliminated");
    expect(
      Math.hypot(
        b.snapshot().pawns[0].position.x - CONFIG.arena.centerX,
        b.snapshot().pawns[0].position.y - CONFIG.arena.centerY
      )
    ).toBeGreaterThan(FLOOR + PAWN_R);
    a.destroy();
    b.destroy();
  });

  it("dispatch and applyCommand drive identical simulations", () => {
    const run = (via: "dispatch" | "applyCommand") => {
      const g = createGame();
      const send = (cmd: GameCommand) =>
        via === "dispatch" ? g.dispatch(cmd) : g.applyCommand(cmd);
      send({ type: "aim", x: 470, y: 390 });
      send({ type: "setPower", power: 4 });
      send({ type: "confirmLaunch" });
      const trace: number[] = [];
      for (let i = 0; i < 120; i++) {
        g.update(DT);
        const p = g.snapshot().pawns[0].position;
        trace.push(p.x, p.y);
      }
      g.destroy();
      return trace;
    };
    expect(run("applyCommand")).toEqual(run("dispatch"));
  });
});
