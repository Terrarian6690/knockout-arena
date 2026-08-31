import { describe, expect, it } from "vitest";
import { CONFIG, launchSpeedFor } from "../config";
import { createArena, floorRadius } from "../arena";
import { createGame, type GameHandle } from "../game";
import type { GameStateSnapshot } from "../types";

const DT = CONFIG.simulation.fixedTimestepMs; // 1000/60
const FLOOR = floorRadius(createArena()); // playable floor radius (264)
const PAWN_R = CONFIG.pawn.radius; // 16
/** Spawn of the single phase-1 pawn: just inside the top rim. */
const SPAWN = { x: CONFIG.arena.centerX, y: 110 };

const pawnOf = (s: GameStateSnapshot) => s.pawns[0];
const distFromCenter = (p: { x: number; y: number }) =>
  Math.hypot(p.x - CONFIG.arena.centerX, p.y - CONFIG.arena.centerY);

/**
 * Drive the game loop with fixed frames until the phase leaves "moving"
 * (or maxFrames is reached). Returns the number of frames consumed.
 */
function pump(g: GameHandle, maxFrames: number, dt: number = DT): number {
  for (let i = 0; i < maxFrames; i++) {
    g.update(dt);
    if (g.snapshot().phase !== "moving") return i + 1;
  }
  return maxFrames;
}

/** Launch inward (downward from the top spawn) — safe, always settles. */
function launchInward(g: GameHandle, power: number) {
  g.dispatch({ type: "aim", x: CONFIG.arena.centerX, y: CONFIG.arena.centerY });
  g.dispatch({ type: "setPower", power });
  g.dispatch({ type: "confirmLaunch" });
}

/** Launch straight at the nearby top rim. */
function launchAtRim(g: GameHandle, power: number) {
  g.dispatch({ type: "aim", x: CONFIG.arena.centerX, y: 40 });
  g.dispatch({ type: "setPower", power });
  g.dispatch({ type: "confirmLaunch" });
}

describe("initial game state", () => {
  it("starts in the aiming phase with the default power", () => {
    const g = createGame();
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    expect(s.power).toBe(CONFIG.power.default);
    g.destroy();
  });

  it("spawns the single pawn at the top edge, alive and at rest", () => {
    const g = createGame();
    const pawn = pawnOf(g.snapshot());
    expect(pawn.id).toBe("p0");
    expect(pawn.position).toEqual(SPAWN);
    expect(pawn.velocity).toEqual({ x: 0, y: 0 });
    expect(pawn.eliminated).toBe(false);
    expect(pawn.isMoving).toBe(false);
    g.destroy();
  });

  it("identifies the local and active pawn", () => {
    const g = createGame();
    const s = g.snapshot();
    expect(s.localPawnId).toBe("p0");
    expect(s.activePawnId).toBe("p0");
    g.destroy();
  });

  it("has no aim direction until the player aims", () => {
    const g = createGame();
    const s = g.snapshot();
    expect(s.isAiming).toBe(false);
    expect(s.aimDirection).toBeNull();
    g.destroy();
  });
});

describe("aiming", () => {
  it("sets a unit aim direction toward the target", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: CONFIG.arena.centerX, y: 400 });
    const s = g.snapshot();
    expect(s.isAiming).toBe(true);
    expect(s.aimDirection).toEqual({ x: 0, y: 1 }); // straight down from spawn
    g.destroy();
  });

  it("updates the direction as the target moves", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 450, y: 400 }); // down
    g.dispatch({ type: "aim", x: 450, y: 40 }); // up
    expect(g.snapshot().aimDirection).toEqual({ x: 0, y: -1 });
    g.destroy();
  });

  it("measures the direction from the pawn, not the world origin", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 0, y: 0 }); // world origin, up-left of spawn
    const dir = g.snapshot().aimDirection!;
    expect(dir.x).toBeLessThan(0);
    expect(dir.y).toBeLessThan(0);
    expect(Math.hypot(dir.x, dir.y)).toBeCloseTo(1, 12);
    g.destroy();
  });

  it("keeps the previous aim when the target is degenerate", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 450, y: 400 });
    g.dispatch({ type: "aim", x: SPAWN.x, y: SPAWN.y }); // on the pawn itself
    expect(g.snapshot().aimDirection).toEqual({ x: 0, y: 1 });
    g.destroy();
  });
});

describe("power selection", () => {
  it("accepts every level in the configured range", () => {
    const g = createGame();
    for (let p = CONFIG.power.min; p <= CONFIG.power.max; p++) {
      g.dispatch({ type: "setPower", power: p });
      expect(g.snapshot().power).toBe(p);
    }
    g.destroy();
  });

  it("clamps values above the maximum", () => {
    const g = createGame();
    g.dispatch({ type: "setPower", power: 99 });
    expect(g.snapshot().power).toBe(CONFIG.power.max);
    g.destroy();
  });

  it("clamps values below the minimum", () => {
    const g = createGame();
    g.dispatch({ type: "setPower", power: -3 });
    expect(g.snapshot().power).toBe(CONFIG.power.min);
    g.destroy();
  });

  it("rounds fractional powers", () => {
    const g = createGame();
    g.dispatch({ type: "setPower", power: 2.4 });
    expect(g.snapshot().power).toBe(2);
    g.dispatch({ type: "setPower", power: 2.6 });
    expect(g.snapshot().power).toBe(3);
    g.destroy();
  });
});

describe("valid launch", () => {
  it("applies the aim direction scaled by the power's launch speed", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 450, y: 400 }); // straight down
    g.dispatch({ type: "setPower", power: 4 });
    g.dispatch({ type: "confirmLaunch" });

    const v = pawnOf(g.snapshot()).velocity;
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(launchSpeedFor(4), 6);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeGreaterThan(0);
    g.destroy();
  });

  it("falls back to the default direction when no aim was set", () => {
    const g = createGame();
    g.dispatch({ type: "setPower", power: 5 });
    g.dispatch({ type: "confirmLaunch" });
    const v = pawnOf(g.snapshot()).velocity;
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeLessThan(0); // default (0,-1): straight at the top rim
    g.destroy();
  });

  it("switches to the moving phase and consumes the aim", () => {
    const g = createGame();
    g.dispatch({ type: "aim", x: 450, y: 400 });
    g.dispatch({ type: "confirmLaunch" });
    const s = g.snapshot();
    expect(s.phase).toBe("moving");
    expect(s.isAiming).toBe(false);
    expect(s.aimDirection).toBeNull();
    expect(pawnOf(s).isMoving).toBe(true);
    g.destroy();
  });

  it("keeps the active pawn during the launch", () => {
    const g = createGame();
    launchInward(g, 2);
    expect(g.snapshot().activePawnId).toBe("p0");
    g.destroy();
  });
});

describe("launch once per turn", () => {
  it("ignores a second confirmLaunch while moving", () => {
    const run = (doubleDispatch: boolean) => {
      const g = createGame();
      launchInward(g, 2);
      if (doubleDispatch) g.dispatch({ type: "confirmLaunch" });
      const trace: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 60; i++) {
        g.update(DT);
        trace.push({ ...pawnOf(g.snapshot()).position });
      }
      g.destroy();
      return trace;
    };
    expect(run(true)).toEqual(run(false));
  });

  it("never applies a second impulse mid-flight (speed only decays)", () => {
    const g = createGame();
    launchInward(g, 3);
    g.update(DT);
    let speed = Math.hypot(...Object.values(pawnOf(g.snapshot()).velocity) as [number, number]);
    for (let i = 0; i < 40; i++) {
      g.dispatch({ type: "confirmLaunch" });
      g.update(DT);
      const next = Math.hypot(...Object.values(pawnOf(g.snapshot()).velocity) as [number, number]);
      expect(next).toBeLessThanOrEqual(speed + 1e-9);
      speed = next;
    }
    g.destroy();
  });
});

describe("movement, friction and settling", () => {
  it("moves the pawn in the aim direction", () => {
    const g = createGame();
    launchInward(g, 3); // down
    for (let i = 0; i < 30; i++) g.update(DT);
    const p = pawnOf(g.snapshot()).position;
    expect(p.y).toBeGreaterThan(SPAWN.y + 30);
    expect(p.x).toBeCloseTo(SPAWN.x, 6);
    g.destroy();
  });

  it("slows the pawn through friction (exponential air decay)", () => {
    const g = createGame();
    launchInward(g, 5);
    const TICKS = 60;
    for (let i = 0; i < TICKS; i++) g.update(DT);
    const v = pawnOf(g.snapshot()).velocity;
    const speed = Math.hypot(v.x, v.y);
    // v(t) = v0 · (1 − frictionAir)^t — verify the tuned decay curve.
    const expected =
      launchSpeedFor(5) * Math.pow(1 - CONFIG.pawn.frictionAir, TICKS);
    expect(speed).toBeCloseTo(expected, 2);
    g.destroy();
  });

  it("settles back to aiming once the pawn comes to rest", () => {
    const g = createGame();
    launchInward(g, 2);
    pump(g, 700);
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    const v = pawnOf(s).velocity;
    expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(CONFIG.simulation.restSpeedThreshold + 1e-9);
    expect(pawnOf(s).eliminated).toBe(false);
    g.destroy();
  });

  it("stops the pawn on the floor after settling", () => {
    const g = createGame();
    launchInward(g, 4);
    pump(g, 700);
    const p = pawnOf(g.snapshot()).position;
    expect(distFromCenter(p)).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });
});

describe("phase transitions", () => {
  it("walks aiming → moving → aiming on a safe launch", () => {
    const g = createGame();
    expect(g.snapshot().phase).toBe("aiming");
    launchInward(g, 2);
    expect(g.snapshot().phase).toBe("moving");
    pump(g, 700);
    expect(g.snapshot().phase).toBe("aiming");
    g.destroy();
  });

  it("walks aiming → moving → eliminated on a rim fly-over", () => {
    const g = createGame();
    launchAtRim(g, 5);
    expect(g.snapshot().phase).toBe("moving");
    pump(g, 700);
    expect(g.snapshot().phase).toBe("eliminated");
    g.destroy();
  });

  it("walks eliminated → aiming on reset", () => {
    const g = createGame();
    launchAtRim(g, 5);
    pump(g, 700);
    g.dispatch({ type: "reset" });
    expect(g.snapshot().phase).toBe("aiming");
    g.destroy();
  });
});

describe("elimination (geometric rule)", () => {
  it("eliminates a fast head-on launch over the rim", () => {
    const g = createGame();
    launchAtRim(g, 5);
    const frames = pump(g, 700);
    const s = g.snapshot();
    expect(s.phase).toBe("eliminated");
    expect(pawnOf(s).eliminated).toBe(true);
    expect(distFromCenter(pawnOf(s).position)).toBeGreaterThan(FLOOR + PAWN_R);
    expect(frames).toBeLessThan(120); // a fly-over resolves quickly
    g.destroy();
  });

  it("freezes the pawn outside the floor", () => {
    const g = createGame();
    launchAtRim(g, 5);
    pump(g, 700);
    const pawn = pawnOf(g.snapshot());
    expect(pawn.velocity).toEqual({ x: 0, y: 0 });
    expect(pawn.isMoving).toBe(false);
    g.destroy();
  });

  it("only eliminates once the pawn has completely left the floor", () => {
    const g = createGame();
    const seen: Array<{ phase: string; dist: number }> = [];
    g.subscribe((s) =>
      seen.push({ phase: s.phase, dist: distFromCenter(pawnOf(s).position) })
    );
    launchAtRim(g, 5);
    for (let i = 0; i < 120; i++) {
      g.update(DT);
      if (g.snapshot().phase === "eliminated") break;
    }
    // While still "moving", the pawn never fully left the floor…
    for (const entry of seen) {
      if (entry.phase === "moving") {
        expect(entry.dist).toBeLessThanOrEqual(FLOOR + PAWN_R + 1e-9);
      }
    }
    // …and the eliminating frame is strictly outside it.
    const last = seen[seen.length - 1];
    expect(last.phase).toBe("eliminated");
    expect(last.dist).toBeGreaterThan(FLOOR + PAWN_R);
    g.destroy();
  });

  it("eliminates fast off-angle launches that still clear the rim speed", () => {
    const g = createGame();
    // Aim 30° off the outward rim normal: outward component 3.6·cos(30°) ≈ 3.1 > 2.3.
    const off = { x: Math.sin(Math.PI / 6), y: -Math.cos(Math.PI / 6) };
    g.dispatch({
      type: "aim",
      x: SPAWN.x + off.x * 300,
      y: SPAWN.y + off.y * 300,
    });
    g.dispatch({ type: "setPower", power: 5 });
    g.dispatch({ type: "confirmLaunch" });
    pump(g, 700);
    expect(g.snapshot().phase).toBe("eliminated");
    g.destroy();
  });
});

describe("weak bounce must not eliminate", () => {
  it("bounces a below-threshold rim hit and settles normally", () => {
    const g = createGame();
    launchAtRim(g, 3); // 1.67 < knockoutSpeed 2.3
    pump(g, 700);
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    expect(pawnOf(s).eliminated).toBe(false);
    expect(distFromCenter(pawnOf(s).position)).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });

  it("never leaves the floor on a weak bounce", () => {
    const g = createGame();
    let maxDist = 0;
    g.subscribe((s) => {
      maxDist = Math.max(maxDist, distFromCenter(pawnOf(s).position));
    });
    launchAtRim(g, 3);
    pump(g, 700);
    expect(maxDist).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });
});

describe("reset", () => {
  it("restores the full initial state after elimination", () => {
    const g = createGame();
    launchAtRim(g, 5);
    pump(g, 700);
    g.dispatch({ type: "reset" });
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    expect(pawnOf(s).position).toEqual(SPAWN);
    expect(pawnOf(s).velocity).toEqual({ x: 0, y: 0 });
    expect(pawnOf(s).eliminated).toBe(false);
    expect(s.power).toBe(CONFIG.power.default);
    expect(s.isAiming).toBe(false);
    g.destroy();
  });

  it("works mid-flight (launch aborted)", () => {
    const g = createGame();
    launchInward(g, 4);
    g.update(DT);
    g.update(DT);
    g.dispatch({ type: "reset" });
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    expect(pawnOf(s).position).toEqual(SPAWN);
    expect(pawnOf(s).velocity).toEqual({ x: 0, y: 0 });
    g.destroy();
  });

  it("restores rim collision after an elimination reset", () => {
    const g = createGame();
    launchAtRim(g, 5); // disables wall collision on fly-over
    pump(g, 700);
    g.dispatch({ type: "reset" });
    // A weak rim hit after reset must bounce again, not pass through.
    launchAtRim(g, 3);
    pump(g, 700);
    const s = g.snapshot();
    expect(s.phase).toBe("aiming");
    expect(distFromCenter(pawnOf(s).position)).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });
});

describe("repeated turns", () => {
  it("supports several consecutive launch → settle cycles", () => {
    const g = createGame();
    for (let turn = 1; turn <= 3; turn++) {
      launchInward(g, turn);
      expect(g.snapshot().phase).toBe("moving");
      const frames = pump(g, 700);
      expect(frames).toBeLessThan(700); // actually settled (no timeout)
      const s = g.snapshot();
      expect(s.phase).toBe("aiming");
      expect(pawnOf(s).eliminated).toBe(false);
    }
    // The pawn drifted toward the center across turns.
    expect(pawnOf(g.snapshot()).position.y).toBeGreaterThan(SPAWN.y + 40);
    g.destroy();
  });

  it("allows launching again immediately after settling", () => {
    const g = createGame();
    launchInward(g, 2);
    pump(g, 700);
    launchInward(g, 2);
    expect(g.snapshot().phase).toBe("moving");
    g.destroy();
  });
});

describe("deterministic simulation", () => {
  const script = (g: GameHandle) => {
    g.dispatch({ type: "aim", x: 500, y: 300 });
    g.dispatch({ type: "setPower", power: 3 });
    g.dispatch({ type: "confirmLaunch" });
    for (let i = 0; i < 120; i++) g.update(DT);
  };

  it("produces bit-identical snapshots for identical runs", () => {
    const a = createGame();
    const b = createGame();
    script(a);
    script(b);
    expect(b.snapshot()).toEqual(a.snapshot());
    a.destroy();
    b.destroy();
  });

  it("produces identical traces tick by tick", () => {
    const trace = () => {
      const g = createGame();
      script(g);
      const t: number[] = [];
      for (let i = 0; i < 120; i++) {
        g.update(DT);
        t.push(pawnOf(g.snapshot()).position.x, pawnOf(g.snapshot()).position.y);
      }
      g.destroy();
      return t;
    };
    expect(trace()).toEqual(trace());
  });

  it("repeats identically on the same instance after a reset", () => {
    const g = createGame();
    script(g);
    const first = g.snapshot();
    g.dispatch({ type: "reset" });
    script(g);
    expect(g.snapshot()).toEqual(first);
    g.destroy();
  });
});

describe("identical trajectories at different render FPS", () => {
  const settleAt = (frameDt: number) => {
    const g = createGame();
    launchInward(g, 3);
    pump(g, 2000, frameDt);
    const s = g.snapshot();
    const pos = { ...pawnOf(s).position };
    g.destroy();
    return { phase: s.phase, pos };
  };

  it("settles at the same spot at 30 / 60 / 120 / 144 Hz", () => {
    const base = settleAt(DT); // 60 Hz
    for (const hz of [30, 120, 144]) {
      const other = settleAt((DT * 60) / hz);
      expect(other.phase).toBe(base.phase);
      expect(other.pos.x).toBeCloseTo(base.pos.x, 9);
      expect(other.pos.y).toBeCloseTo(base.pos.y, 9);
    }
  });

  it("eliminates at the same spot at 30 / 60 / 120 / 144 Hz", () => {
    const eliminateAt = (frameDt: number) => {
      const g = createGame();
      launchAtRim(g, 5);
      pump(g, 2000, frameDt);
      const pos = { ...pawnOf(g.snapshot()).position };
      g.destroy();
      return pos;
    };
    const base = eliminateAt(DT);
    for (const hz of [30, 120, 144]) {
      const other = eliminateAt((DT * 60) / hz);
      expect(other.x).toBeCloseTo(base.x, 9);
      expect(other.y).toBeCloseTo(base.y, 9);
    }
  });
});

describe("rim pass-over behavior", () => {
  it("clears the rim only when the outward speed meets the knockout speed", () => {
    // Power 4 (≈2.58 > 2.3) and 5 (3.6) fly over; power 3 (≈1.67) bounces.
    for (const [power, expectOut] of [
      [4, true],
      [5, true],
      [3, false],
      [2, false],
    ] as const) {
      const g = createGame();
      launchAtRim(g, power);
      pump(g, 700);
      const out = g.snapshot().phase === "eliminated";
      expect(out).toBe(expectOut);
      g.destroy();
    }
  });

  it("keeps the walls solid for a pawn that stays slow near the rim", () => {
    const g = createGame();
    // Aim along the rim (tangentially): the pawn hugs the wall without the
    // outward speed to clear it, so it must never slip out.
    const tangential = { x: 150, y: 110 }; // roughly along the top rim
    g.dispatch({ type: "aim", x: tangential.x, y: tangential.y });
    g.dispatch({ type: "setPower", power: 3 });
    g.dispatch({ type: "confirmLaunch" });
    pump(g, 700);
    const s = g.snapshot();
    expect(pawnOf(s).eliminated).toBe(false);
    expect(distFromCenter(pawnOf(s).position)).toBeLessThan(FLOOR + PAWN_R);
    g.destroy();
  });
});

describe("invalid actions during moving", () => {
  it("ignores aim changes mid-flight", () => {
    const g = createGame();
    launchInward(g, 3);
    g.dispatch({ type: "aim", x: 100, y: 500 });
    const s = g.snapshot();
    expect(s.aimDirection).toBeNull();
    expect(s.isAiming).toBe(false);
    g.destroy();
  });

  it("ignores power changes mid-flight", () => {
    const g = createGame();
    launchInward(g, 2);
    g.dispatch({ type: "setPower", power: 5 });
    expect(g.snapshot().power).toBe(2);
    g.destroy();
  });

  it("does not let interference alter the trajectory", () => {
    const run = (interfere: boolean) => {
      const g = createGame();
      launchInward(g, 3);
      if (interfere) {
        g.dispatch({ type: "aim", x: 100, y: 100 });
        g.dispatch({ type: "setPower", power: 5 });
        g.dispatch({ type: "confirmLaunch" });
      }
      const trace: number[] = [];
      for (let i = 0; i < 80; i++) {
        g.update(DT);
        trace.push(pawnOf(g.snapshot()).position.x, pawnOf(g.snapshot()).position.y);
      }
      g.destroy();
      return trace;
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe("invalid actions during eliminated", () => {
  const eliminatedGame = () => {
    const g = createGame();
    launchAtRim(g, 5);
    pump(g, 700);
    return g;
  };

  it("rejects further launches until reset", () => {
    const g = eliminatedGame();
    const frozen = { ...pawnOf(g.snapshot()).position };
    g.dispatch({ type: "confirmLaunch" });
    g.update(DT);
    expect(g.snapshot().phase).toBe("eliminated");
    expect(pawnOf(g.snapshot()).position).toEqual(frozen);
    g.destroy();
  });

  it("ignores aim and power changes while eliminated", () => {
    const g = eliminatedGame();
    g.dispatch({ type: "aim", x: 450, y: 400 });
    g.dispatch({ type: "setPower", power: 1 });
    const s = g.snapshot();
    expect(s.phase).toBe("eliminated");
    expect(s.power).toBe(5); // unchanged from the eliminating launch
    expect(s.aimDirection).toBeNull();
    g.destroy();
  });

  it("ignores updates while eliminated (no background simulation)", () => {
    const g = eliminatedGame();
    const frozen = { ...pawnOf(g.snapshot()).position };
    for (let i = 0; i < 120; i++) g.update(DT);
    expect(g.snapshot().phase).toBe("eliminated");
    expect(pawnOf(g.snapshot()).position).toEqual(frozen);
    g.destroy();
  });

  it("accepts reset from the eliminated phase", () => {
    const g = eliminatedGame();
    g.dispatch({ type: "reset" });
    expect(g.snapshot().phase).toBe("aiming");
    g.destroy();
  });
});

describe("update loop hygiene", () => {
  it("is a no-op while aiming (no physics, no emissions)", () => {
    const g = createGame();
    let emissions = 0;
    g.subscribe(() => emissions++); // initial push
    expect(emissions).toBe(1);
    for (let i = 0; i < 60; i++) g.update(DT);
    expect(emissions).toBe(1);
    expect(pawnOf(g.snapshot()).position).toEqual(SPAWN);
    g.destroy();
  });

  it("tolerates zero and negative frame deltas", () => {
    const g = createGame();
    launchInward(g, 3);
    expect(() => {
      g.update(0);
      g.update(-5);
    }).not.toThrow();
    expect(g.snapshot().phase).toBe("moving");
    g.destroy();
  });

  it("clamps huge frame gaps (no catch-up spiral)", () => {
    const g = createGame();
    launchInward(g, 3);
    const before = { ...pawnOf(g.snapshot()).position };
    g.update(5000); // e.g. a tab was backgrounded — at most maxFrameMs is simulated
    const after = pawnOf(g.snapshot()).position;
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    expect(moved).toBeLessThanOrEqual(
      (CONFIG.simulation.maxFrameMs / DT) * launchSpeedFor(3) + 1e-9
    );
    g.destroy();
  });

  it("emits state every frame while moving", () => {
    const g = createGame();
    let emissions = 0;
    g.subscribe(() => emissions++);
    launchInward(g, 3); // dispatch emissions
    const duringDispatch = emissions;
    for (let i = 0; i < 30; i++) g.update(DT);
    expect(emissions - duringDispatch).toBe(30);
    g.destroy();
  });
});

describe("subscribe / destroy", () => {
  it("pushes the current state immediately on subscribe", () => {
    const g = createGame();
    let latest: GameStateSnapshot | null = null;
    g.subscribe((s) => (latest = s));
    expect(latest).not.toBeNull();
    expect(latest!.phase).toBe("aiming");
    g.destroy();
  });

  it("stops delivering after unsubscribe", () => {
    const g = createGame();
    let calls = 0;
    const unsub = g.subscribe(() => calls++);
    unsub();
    g.dispatch({ type: "setPower", power: 5 });
    expect(calls).toBe(1); // only the initial push
    g.destroy();
  });

  it("destroy clears listeners and is safe to dispatch after", () => {
    const g = createGame();
    let calls = 0;
    g.subscribe(() => calls++);
    g.destroy();
    expect(() => g.dispatch({ type: "reset" })).not.toThrow();
    expect(calls).toBe(1); // no further emissions
    expect(g.snapshot().phase).toBe("aiming");
  });

  it("returns fresh snapshot objects (no shared mutable state)", () => {
    const g = createGame();
    const first = g.snapshot();
    first.pawns[0].position.x = 9999;
    first.power = 9999;
    const second = g.snapshot();
    expect(second.pawns[0].position.x).toBe(SPAWN.x);
    expect(second.power).toBe(CONFIG.power.default);
    g.destroy();
  });
});
