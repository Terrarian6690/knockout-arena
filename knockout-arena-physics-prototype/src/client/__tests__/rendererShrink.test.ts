import { describe, expect, it } from "vitest";
import {
  CONFIG,
  arenaFromSnapshot,
  createArena,
  floorRadius,
  type GameStateSnapshot,
  type PawnSnapshot,
} from "../../game";
import { render } from "../renderer";

/**
 * RENDERING the shrinking arena.
 *
 * The arena must be drawn at the radius the AUTHORITATIVE snapshot
 * reports — that is the whole client-side contract of Task 5. Pinned
 * against the pure renderer with a recording 2D context (no canvas, no
 * DOM): the arcs it emits are the arena, so their radii are the proof.
 *
 * Also pinned: the boundary ring stays a VISUAL marker (drawing is all
 * that changes — no collider is involved on this side of the wire), and
 * an older snapshot without the arena field still draws a full arena.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const INITIAL = CONFIG.arena.radius;
const MIN = CONFIG.arena.shrink.minRadius;
const RING = CONFIG.arena.wallThickness;

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
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Radii of every arc drawn centered on the arena center. */
function arenaArcRadii(calls: Call[]): number[] {
  return calls
    .filter((c) => c.op === "arc")
    .map((c) => c.args as [number, number, number])
    .filter(([x, y]) => x === CX && y === CY)
    .map(([, , r]) => r);
}

function pawn(id: string): PawnSnapshot {
  return {
    id,
    name: id,
    position: { x: CX, y: CY },
    velocity: { x: 0, y: 0 },
    radius: 16,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: id === "p0",
    colorIndex: 0,
  };
}

function snap(radius: number | null): GameStateSnapshot {
  const base: GameStateSnapshot = {
    phase: "aiming",
    pawns: [pawn("p0")],
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
  };
  if (radius === null) return base;
  return {
    ...base,
    arena: {
      radius,
      roundsUntilShrink: 3,
      nextRadius: radius - CONFIG.arena.shrink.amount,
      shrinkWarning: false,
      atMinRadius: radius <= MIN,
    },
  };
}

/** Draw a snapshot exactly the way the app does. */
function draw(snapshot: GameStateSnapshot) {
  const { ctx, calls } = recordingCtx();
  render(ctx, snapshot, arenaFromSnapshot(snapshot), {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
  return calls;
}

describe("the renderer draws the AUTHORITATIVE arena radius", () => {
  it("draws the full arena for a fresh match", () => {
    const radii = arenaArcRadii(draw(snap(INITIAL)));
    expect(radii).toContain(INITIAL); // the boundary ring
    expect(radii).toContain(INITIAL - RING); // the floor edge
  });

  it("draws a SMALLER arena once the server has shrunk it", () => {
    const shrunk = INITIAL - CONFIG.arena.shrink.amount;
    const radii = arenaArcRadii(draw(snap(shrunk)));
    expect(radii).toContain(shrunk);
    expect(radii).toContain(shrunk - RING);
    // …and nothing is still drawn at the old size.
    expect(radii).not.toContain(INITIAL);
    expect(radii).not.toContain(INITIAL - RING);
  });

  it("keeps the arena CENTERED at every size", () => {
    for (const radius of [INITIAL, 280, 230, MIN]) {
      const calls = draw(snap(radius));
      const arcs = calls
        .filter((c) => c.op === "arc")
        .map((c) => c.args as [number, number, number]);
      const ringArcs = arcs.filter(([, , r]) => r === radius);
      expect(ringArcs.length).toBeGreaterThan(0);
      for (const [x, y] of ringArcs) {
        expect(x).toBe(CX);
        expect(y).toBe(CY);
      }
    }
  });

  it("scales the whole arena drawing down with the radius", () => {
    const big = arenaArcRadii(draw(snap(INITIAL)));
    const small = arenaArcRadii(draw(snap(MIN)));
    // Same number of arena arcs, every one of them smaller.
    expect(small.length).toBe(big.length);
    expect(Math.max(...small)).toBeLessThan(Math.max(...big));
  });

  it("falls back to the full arena for a snapshot without the field", () => {
    const radii = arenaArcRadii(draw(snap(null)));
    expect(radii).toContain(INITIAL);
  });

  it("matches the logical floor the engine eliminates against", () => {
    // The drawn floor edge and the elimination geometry must be the same
    // number at every radius — one source of truth, one visible edge.
    for (const radius of [INITIAL, 280, MIN]) {
      const radii = arenaArcRadii(draw(snap(radius)));
      expect(radii).toContain(floorRadius(createArena(radius)));
    }
  });
});
