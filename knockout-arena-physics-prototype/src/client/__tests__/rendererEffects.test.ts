import { describe, expect, it } from "vitest";
import { createArena, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { computeTransform, render } from "../renderer";
import type { EffectFrame } from "../effects";

/**
 * The renderer's EFFECT layer, pinned with a recording 2D context (same
 * technique as rendererAim.test.ts — the renderer stays a pure function):
 *
 *   - trail dots, rings and particles are drawn UNDER the pawns and under
 *     the aim indicators (nothing may obscure gameplay elements);
 *   - the winner halo appears ONLY for the authoritative winner in the
 *     finished phase (never mid-match, never for an eliminated "winner",
 *     never without an effects frame... the halo is a render rule, so it
 *     also shows with no effects argument at all);
 *   - callers that pass no effects frame render exactly as before.
 */

const ARENA = createArena();
const TRANSFORM = computeTransform(900, 700);

interface Call {
  op: string;
  args: unknown[];
}

function recordingCtx() {
  const calls: Call[] = [];
  const gradient = { addColorStop: () => {} };
  const methods = [
    "save",
    "restore",
    "clearRect",
    "fillRect",
    "translate",
    "scale",
    "beginPath",
    "closePath",
    "arc",
    "fill",
    "stroke",
    "setLineDash",
    "moveTo",
    "lineTo",
  ];
  const target: Record<string, unknown> = {
    canvas: { width: 900, height: 700 },
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ op: "createRadialGradient", args });
      return gradient;
    },
  };
  for (const op of methods) {
    target[op] = (...args: unknown[]) => {
      calls.push({ op, args });
    };
  }
  const props = new Map<string, unknown>();
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return props.get(prop);
    },
    set(_t, prop: string, value) {
      props.set(prop, value);
      calls.push({ op: `set:${prop}`, args: [value] });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** Index of the first arc(x, y, r, …) call at a given center + radius. */
function arcIndexAt(calls: Call[], x: number, y: number, r: number): number {
  const i = calls.findIndex(
    (c) =>
      c.op === "arc" &&
      Math.abs((c.args[0] as number) - x) < 0.001 &&
      Math.abs((c.args[1] as number) - y) < 0.001 &&
      Math.abs((c.args[2] as number) - r) < 0.001
  );
  return i;
}

function pawnAt(
  id: string,
  x: number,
  y: number,
  overrides: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name: `Player ${id}`,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    radius: 16,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: false,
    colorIndex: 0,
    ...overrides,
  };
}

function state(
  phase: GameStateSnapshot["phase"],
  pawns: PawnSnapshot[],
  overrides: Partial<GameStateSnapshot> = {}
): GameStateSnapshot {
  return {
    phase,
    pawns,
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
    ...overrides,
  };
}

const FRAME: EffectFrame = {
  trails: [{ x: 100, y: 100, r: 5, alpha: 0.3, color: "#4cc9f0" }],
  rings: [{ x: 300, y: 200, r: 20, alpha: 0.5, color: "#ffd166", width: 2 }],
  particles: [{ x: 200, y: 150, r: 2.5, alpha: 0.8, color: "#ffffff" }],
};

describe("renderer effect layer", () => {
  it("draws trails, rings and particles under the pawns", () => {
    const { ctx, calls } = recordingCtx();
    const snapshot = state("moving", [pawnAt("p0", 450, 350, { isLocal: true }), pawnAt("p1", 600, 350)]);
    render(ctx, snapshot, ARENA, TRANSFORM, FRAME);
    // Every effect element is painted BEFORE the pawn bodies.
    const trail = arcIndexAt(calls, 100, 100, 5);
    const ring = arcIndexAt(calls, 300, 200, 20);
    const particle = arcIndexAt(calls, 200, 150, 2.5);
    const pawnBody = arcIndexAt(calls, 450, 350, 16);
    const otherPawn = arcIndexAt(calls, 600, 350, 16);
    expect(trail).toBeGreaterThanOrEqual(0);
    expect(ring).toBeGreaterThanOrEqual(0);
    expect(particle).toBeGreaterThanOrEqual(0);
    expect(pawnBody).toBeGreaterThanOrEqual(0);
    expect(otherPawn).toBeGreaterThanOrEqual(0);
    expect(trail).toBeLessThan(pawnBody);
    expect(ring).toBeLessThan(pawnBody);
    expect(particle).toBeLessThan(pawnBody);
    expect(particle).toBeLessThan(otherPawn);
  });

  it("draws the winner halo only for the authoritative finished winner", () => {
    const finished = state(
      "finished",
      [pawnAt("p0", 450, 350, { isLocal: true }), pawnAt("p1", 600, 350)],
      { winnerId: "p1" }
    );
    const { ctx, calls } = recordingCtx();
    render(ctx, finished, ARENA, TRANSFORM);
    expect(arcIndexAt(calls, 600, 350, 16 + 6)).toBeGreaterThanOrEqual(0); // halo
    expect(arcIndexAt(calls, 600, 350, 16 + 11)).toBeGreaterThanOrEqual(0);
    expect(arcIndexAt(calls, 450, 350, 16 + 6)).toBe(-1); // the loser: none

    // Not in the finished phase → no halo, even for a crafted snapshot.
    const moving = { ...finished, phase: "moving" as const };
    const rec2 = recordingCtx();
    render(rec2.ctx, moving, ARENA, TRANSFORM);
    expect(arcIndexAt(rec2.calls, 600, 350, 16 + 6)).toBe(-1);

    // An eliminated "winner" (corrupt verdict) gets no halo either.
    const corrupt = {
      ...finished,
      pawns: finished.pawns.map((p) => (p.id === "p1" ? { ...p, eliminated: true } : p)),
    };
    const rec3 = recordingCtx();
    render(rec3.ctx, corrupt, ARENA, TRANSFORM);
    expect(arcIndexAt(rec3.calls, 600, 350, 16 + 6)).toBe(-1);
  });

  it("renders without an effects frame exactly as before (solo callers)", () => {
    const { ctx, calls } = recordingCtx();
    const snapshot = state("aiming", [pawnAt("p0", 450, 350, { isLocal: true })], {
      isAiming: true,
      aimDirection: { x: 1, y: 0 },
    });
    // Four-argument call — the pre-Task-18 signature.
    render(ctx, snapshot, ARENA, TRANSFORM);
    expect(arcIndexAt(calls, 450, 350, 16)).toBeGreaterThanOrEqual(0); // pawn drawn
    expect(calls.some((c) => c.op === "arc" && (c.args[2] as number) === 5)).toBe(false); // no effect dots
  });
});
