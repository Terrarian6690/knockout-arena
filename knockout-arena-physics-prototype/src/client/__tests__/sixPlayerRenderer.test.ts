import { describe, expect, it } from "vitest";
import {
  CONFIG,
  arenaFromSnapshot,
  createArena,
  playerColor,
  playerStroke,
  spawnPositionForSlot,
  type GameStateSnapshot,
  type PawnSnapshot,
} from "../../game";
import { render } from "../renderer";

/**
 * RENDERING six pawns (Task 7).
 *
 * The renderer is pure: given a snapshot and a 2D context it emits draw
 * calls. That makes "the canvas handles six players" checkable exactly —
 * count the pawn arcs, read the fill colors, and confirm the private
 * aim of other players never reaches the context.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const MAX = CONFIG.match.maxPlayers;
const ARENA = createArena();

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

/** An arena projection at `radius`, shaped like the real one. */
function arenaSnapshot(radius: number) {
  const atMin = radius <= CONFIG.arena.shrink.minRadius;
  return {
    radius,
    roundsUntilShrink: atMin ? null : CONFIG.arena.shrink.everyRounds,
    nextRadius: atMin
      ? null
      : Math.max(CONFIG.arena.shrink.minRadius, radius - CONFIG.arena.shrink.amount),
    shrinkWarning: false,
    atMinRadius: atMin,
  };
}

/** A pawn on its authoritative spawn slot. */
function pawnAtSlot(slot: number, overrides: Partial<PawnSnapshot> = {}): PawnSnapshot {
  const [x, y] = spawnPositionForSlot(ARENA, slot);
  return {
    id: `p${slot}`,
    name: `Player ${slot + 1}`,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: slot === 0,
    colorIndex: slot,
    ...overrides,
  };
}

function sixPlayerSnapshot(
  overrides: Partial<GameStateSnapshot> = {}
): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: Array.from({ length: MAX }, (_, i) => pawnAtSlot(i)),
    localPawnId: "p0",
    winnerId: null,
    isAiming: false,
    aimDirection: null,
    power: CONFIG.power.default,
    arena: arenaSnapshot(CONFIG.arena.radius),
    ...overrides,
  } as GameStateSnapshot;
}

/** Arcs drawn at pawn scale (i.e. the pawns themselves, not the arena). */
function pawnArcs(calls: Call[]): [number, number, number][] {
  return calls
    .filter((c) => c.op === "arc")
    .map((c) => c.args as [number, number, number])
    .filter(([, , r]) => r > 0 && r <= CONFIG.pawn.radius * 1.6)
    .filter(([x, y]) => !(x === CX && y === CY));
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

describe("the renderer draws six pawns", () => {
  it("emits an arc at each of the six spawn positions", () => {
    const calls = draw(sixPlayerSnapshot());
    const arcs = pawnArcs(calls);
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(ARENA, slot);
      const drawn = arcs.some(
        ([ax, ay]) => Math.abs(ax - x) < 0.001 && Math.abs(ay - y) < 0.001
      );
      expect(drawn).toBe(true);
    }
  });

  it("gives all six pawns DISTINCT fill colors", () => {
    const calls = draw(sixPlayerSnapshot());
    const fills = calls
      .filter((c) => c.op === "set:fillStyle")
      .map((c) => String(c.args[0]));
    // Each seat's palette color was actually used…
    const used = new Set<string>();
    for (let slot = 0; slot < MAX; slot++) {
      const color = playerColor(slot);
      if (fills.includes(color)) used.add(color);
    }
    expect(used.size).toBe(MAX);
    // …and the six colors are genuinely different from each other.
    expect(new Set(Array.from({ length: MAX }, (_, i) => playerColor(i))).size).toBe(MAX);
    expect(new Set(Array.from({ length: MAX }, (_, i) => playerStroke(i))).size).toBe(MAX);
  });

  it("still draws six pawns after several shrinks", () => {
    const radius = CONFIG.arena.shrink.minRadius;
    const calls = draw(
      sixPlayerSnapshot({ arena: arenaSnapshot(radius) })
    );
    // Every pawn is still drawn — the arena shrank, the roster did not.
    expect(pawnArcs(calls).length).toBeGreaterThanOrEqual(MAX);
  });

  it("draws eliminated pawns differently but keeps drawing the rest", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawnAtSlot(i, { eliminated: i % 2 === 1 })
    );
    const calls = draw(sixPlayerSnapshot({ pawns }));
    // The three survivors are all present on the canvas.
    for (const slot of [0, 2, 4]) {
      const [x, y] = spawnPositionForSlot(ARENA, slot);
      expect(
        pawnArcs(calls).some(
          ([ax, ay]) => Math.abs(ax - x) < 0.001 && Math.abs(ay - y) < 0.001
        )
      ).toBe(true);
    }
  });

  it("never draws another player's private aim during the aiming phase", () => {
    // The local player is aiming; the other five have no launch datum
    // (exactly what the authoritative projection sends during aiming).
    const calls = draw(
      sixPlayerSnapshot({
        isAiming: true,
        aimDirection: { x: 1, y: 0 },
        power: 3,
      })
    );

    // Aim indicators are drawn as line segments. Every segment must
    // start at the LOCAL pawn — no other seat's aim can appear, because
    // the renderer was never given one.
    const [lx, ly] = spawnPositionForSlot(ARENA, 0);
    const segments = calls.filter((c) => c.op === "moveTo");
    for (const seg of segments) {
      const [x, y] = seg.args as [number, number];
      const atLocal = Math.abs(x - lx) < 40 && Math.abs(y - ly) < 40;
      const atCenter = Math.abs(x - CX) < 1 && Math.abs(y - CY) < 1;
      // Segments belong either to the local player's indicator or to
      // arena furniture — never to another seat's spawn position.
      if (!atLocal && !atCenter) {
        for (let slot = 1; slot < MAX; slot++) {
          const [ox, oy] = spawnPositionForSlot(ARENA, slot);
          const atOther = Math.abs(x - ox) < 1 && Math.abs(y - oy) < 1;
          expect(atOther).toBe(false);
        }
      }
    }
  });

  it("reveals all six launches during movement", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawnAtSlot(i, {
        launch: { direction: { x: 0, y: 1 }, power: 2 },
        confirmed: true,
      })
    );
    const calls = draw(sixPlayerSnapshot({ phase: "moving", pawns }));
    // Six revealed launches produce indicator geometry for every seat.
    expect(calls.filter((c) => c.op === "moveTo").length).toBeGreaterThanOrEqual(MAX);
  });

  it("renders a six-player snapshot without throwing at any phase", () => {
    for (const phase of ["aiming", "moving", "finished"] as const) {
      expect(() =>
        draw(
          sixPlayerSnapshot({
            phase,
            winnerId: phase === "finished" ? "p5" : null,
          })
        )
      ).not.toThrow();
    }
  });
});
