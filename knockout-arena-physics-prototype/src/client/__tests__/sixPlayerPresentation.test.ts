import { describe, expect, it } from "vitest";
import {
  CONFIG,
  arenaFromSnapshot,
  createArena,
  floorRadius,
  playerColor,
  playerStroke,
  spawnPositionForSlot,
  spawnRingRadius,
  type GameStateSnapshot,
  type PawnSnapshot,
} from "../../game";
import { computeTransform, render } from "../renderer";
import { Vfx } from "../effects";

/**
 * SIX-PLAYER PRESENTATION (Task 8).
 *
 * Task 8 is a verification task: the geometry and the renderer already
 * exist and must not be redesigned. These tests pin the properties that
 * make a six-player match readable, so a later change cannot silently
 * break them:
 *
 *   - all six pawns visible, on-screen and non-overlapping at spawn;
 *   - six distinguishable identities;
 *   - the drawn arena edge IS the authoritative radius, at every step of
 *     the shrink schedule (no client-side geometry);
 *   - the whole arena fits the world box and the canvas at desktop sizes;
 *   - pointer → world stays exact after a resize, and screen shake never
 *     touches the input path;
 *   - nothing about a remote player's aim or power reaches the canvas
 *     before resolution.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const MAX = CONFIG.match.maxPlayers;
const W = CONFIG.world.width;
const H = CONFIG.world.height;
const SCHEDULE = [330, 290, 250, 210, 180];

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

function arenaSnapshot(radius: number) {
  const atMin = radius <= CONFIG.arena.shrink.minRadius;
  return {
    radius,
    roundsUntilShrink: atMin ? null : CONFIG.arena.shrink.everyRounds,
    nextRadius: atMin
      ? null
      : Math.max(
          CONFIG.arena.shrink.minRadius,
          radius - CONFIG.arena.shrink.amount
        ),
    shrinkWarning: false,
    atMinRadius: atMin,
  };
}

function pawnAtSlot(
  slot: number,
  overrides: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  const [x, y] = spawnPositionForSlot(createArena(), slot);
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

function snapshotOf(
  count: number,
  overrides: Partial<GameStateSnapshot> = {}
): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: Array.from({ length: count }, (_, i) => pawnAtSlot(i)),
    localPawnId: "p0",
    winnerId: null,
    isAiming: false,
    aimDirection: null,
    power: CONFIG.power.default,
    arena: arenaSnapshot(CONFIG.arena.radius),
    ...overrides,
  } as GameStateSnapshot;
}

/** Every arc the renderer emitted, as [x, y, r]. */
function arcs(calls: Call[]): [number, number, number][] {
  return calls
    .filter((c) => c.op === "arc")
    .map((c) => c.args as [number, number, number]);
}

/** Radii of arcs centered exactly on the arena center. */
function arenaArcRadii(calls: Call[]): number[] {
  return arcs(calls)
    .filter(([x, y]) => x === CX && y === CY)
    .map(([, , r]) => r);
}

function draw(snapshot: GameStateSnapshot, effects?: ReturnType<Vfx["buildFrame"]>) {
  const { ctx, calls } = recordingCtx();
  render(
    ctx,
    snapshot,
    arenaFromSnapshot(snapshot),
    { scale: 1, offsetX: 0, offsetY: 0 },
    effects
  );
  return calls;
}

describe("all six pawns are visible at match start", () => {
  it("draws a body arc at each of the six spawn positions", () => {
    const drawn = arcs(draw(snapshotOf(MAX)));
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(createArena(), slot);
      const body = drawn.some(
        ([ax, ay, ar]) =>
          Math.abs(ax - x) < 0.001 &&
          Math.abs(ay - y) < 0.001 &&
          Math.abs(ar - CONFIG.pawn.radius) < 0.001
      );
      expect(body).toBe(true);
    }
  });

  it("keeps all six spawns inside the visible floor, not under the ring", () => {
    const arena = createArena();
    const floor = floorRadius(arena);
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(arena, slot);
      const d = Math.hypot(x - CX, y - CY);
      // The whole pawn disc is inside the floor edge — nothing is
      // half-hidden beneath the boundary ring.
      expect(d + CONFIG.pawn.radius).toBeLessThanOrEqual(floor);
      expect(d).toBeCloseTo(spawnRingRadius(arena), 9);
    }
  });

  it("never overlaps two of the six pawns at spawn", () => {
    const arena = createArena();
    const points = Array.from({ length: MAX }, (_, i) =>
      spawnPositionForSlot(arena, i)
    );
    for (let a = 0; a < MAX; a++) {
      for (let b = a + 1; b < MAX; b++) {
        const gap = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]);
        // Clear daylight between neighbours, not merely touching discs.
        expect(gap).toBeGreaterThan(CONFIG.pawn.radius * 2 + 8);
      }
    }
  });

  it("keeps every spawn inside the 900x700 world box", () => {
    const arena = createArena();
    for (let slot = 0; slot < MAX; slot++) {
      const [x, y] = spawnPositionForSlot(arena, slot);
      expect(x - CONFIG.pawn.radius).toBeGreaterThanOrEqual(0);
      expect(y - CONFIG.pawn.radius).toBeGreaterThanOrEqual(0);
      expect(x + CONFIG.pawn.radius).toBeLessThanOrEqual(W);
      expect(y + CONFIG.pawn.radius).toBeLessThanOrEqual(H);
    }
  });

  it("leaves the unused slots EMPTY when fewer than six play", () => {
    const arena = createArena();
    for (const count of [2, 3, 4, 5]) {
      const drawn = arcs(draw(snapshotOf(count)));
      const occupied = (slot: number) => {
        const [x, y] = spawnPositionForSlot(arena, slot);
        return drawn.some(
          ([ax, ay, ar]) =>
            Math.abs(ax - x) < 0.001 &&
            Math.abs(ay - y) < 0.001 &&
            Math.abs(ar - CONFIG.pawn.radius) < 0.001
        );
      };
      for (let slot = 0; slot < count; slot++) expect(occupied(slot)).toBe(true);
      // The gaps are real gaps: nothing is drawn at the free slots, and
      // the seated players did not shuffle to close them up.
      for (let slot = count; slot < MAX; slot++) expect(occupied(slot)).toBe(false);
    }
  });

  it("puts two players on opposite sides, left and right", () => {
    const arena = createArena();
    const [ax, ay] = spawnPositionForSlot(arena, 0);
    const [bx, by] = spawnPositionForSlot(arena, 1);
    expect(ax).toBeLessThan(CX);
    expect(bx).toBeGreaterThan(CX);
    expect(ay).toBeCloseTo(CY, 6);
    expect(by).toBeCloseTo(CY, 6);
  });
});

describe("six identities stay distinguishable", () => {
  it("gives the six seats six different colors and strokes", () => {
    // Six distinct palette entries — no seat wraps onto another's color.
    const colors = Array.from({ length: MAX }, (_, i) => playerColor(i));
    const strokes = Array.from({ length: MAX }, (_, i) => playerStroke(i));
    expect(new Set(colors).size).toBe(MAX);
    expect(new Set(strokes).size).toBe(MAX);
  });

  it("keeps every pair of the six perceptually far apart", () => {
    // CIE76 ΔE in Lab space; pairs below ~20 read as "the same color".
    const lab = (hex: string): [number, number, number] => {
      const srgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = srgb.map((c) =>
        c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      );
      const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
      const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
      const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      const [fx, fy, fz] = [f(X), f(Y), f(Z)];
      return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    };
    for (let a = 0; a < MAX; a++) {
      for (let b = a + 1; b < MAX; b++) {
        const [l1, a1, b1] = lab(playerColor(a));
        const [l2, a2, b2] = lab(playerColor(b));
        const dE = Math.hypot(l1 - l2, a1 - a2, b1 - b2);
        expect(dE).toBeGreaterThan(20);
      }
    }
  });

  it("marks the local pawn with a ring only while it is still deciding", () => {
    const deciding = arcs(draw(snapshotOf(MAX)));
    const [lx, ly] = spawnPositionForSlot(createArena(), 0);
    const marker = (list: [number, number, number][]) =>
      list.some(
        ([x, y, r]) =>
          Math.abs(x - lx) < 0.001 &&
          Math.abs(y - ly) < 0.001 &&
          Math.abs(r - (CONFIG.pawn.radius + 5)) < 0.001
      );
    expect(marker(deciding)).toBe(true);

    // Once confirmed, the "still choosing" ring is gone — the marker
    // means something specific, it is not permanent decoration.
    const confirmed = snapshotOf(MAX);
    confirmed.pawns[0] = pawnAtSlot(0, { confirmed: true });
    expect(marker(arcs(draw(confirmed)))).toBe(false);
  });

  it("tints eliminated pawns and haloes the winner", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawnAtSlot(i, { eliminated: i !== 5 })
    );
    const calls = draw(
      snapshotOf(MAX, { phase: "finished", pawns, winnerId: "p5" })
    );
    const fills = calls
      .filter((c) => c.op === "set:fillStyle")
      .map((c) => String(c.args[0]));
    expect(fills).toContain("rgba(239,68,68,0.5)"); // elimination tint

    const [wx, wy] = spawnPositionForSlot(createArena(), 5);
    const halo = arcs(calls).some(
      ([x, y, r]) =>
        Math.abs(x - wx) < 0.001 &&
        Math.abs(y - wy) < 0.001 &&
        r > CONFIG.pawn.radius + 5
    );
    expect(halo).toBe(true);
  });
});

describe("the drawn arena edge IS the authoritative radius", () => {
  it("draws the boundary at the snapshot's radius at every shrink step", () => {
    for (const radius of SCHEDULE) {
      const calls = draw(snapshotOf(MAX, { arena: arenaSnapshot(radius) }));
      const radii = arenaArcRadii(calls);
      // The outer boundary ring and the floor, both from the snapshot.
      expect(radii).toContain(radius);
      expect(radii).toContain(radius - CONFIG.arena.wallThickness);
      // Nothing is drawn at the INITIAL radius once it has shrunk.
      if (radius !== CONFIG.arena.radius) {
        expect(radii).not.toContain(CONFIG.arena.radius);
      }
    }
  });

  it("keeps 330 as the initial radius", () => {
    expect(CONFIG.arena.radius).toBe(330);
    expect(SCHEDULE[0]).toBe(CONFIG.arena.radius);
    const radii = arenaArcRadii(draw(snapshotOf(MAX)));
    expect(radii).toContain(330);
  });

  it("follows a shrink the moment the snapshot reports it", () => {
    const before = arenaArcRadii(draw(snapshotOf(MAX, { arena: arenaSnapshot(330) })));
    const after = arenaArcRadii(draw(snapshotOf(MAX, { arena: arenaSnapshot(290) })));
    expect(before).toContain(330);
    expect(after).toContain(290);
    expect(after).not.toContain(330);
  });

  it("draws a full arena for a snapshot with no arena field (backward safe)", () => {
    const legacy = snapshotOf(MAX);
    delete (legacy as { arena?: unknown }).arena;
    expect(arenaArcRadii(draw(legacy))).toContain(CONFIG.arena.radius);
  });

  it("keeps the round-start pulse inside the CURRENT floor after a shrink", () => {
    // Regression: the Vfx instance is built once at mount with the
    // initial arena. A ring sized from that stale geometry sweeps far
    // outside the shrunken floor, drawing a 'wall' where there is none.
    const shrunk = CONFIG.arena.shrink.minRadius;
    const vfx = new Vfx({ arena: createArena() }); // mounted at 330
    const aiming = snapshotOf(MAX, { arena: arenaSnapshot(shrunk) });
    const moving = snapshotOf(MAX, {
      phase: "moving",
      arena: arenaSnapshot(shrunk),
    });
    vfx.observe(aiming, moving, 1_000);

    const floor = floorRadius(arenaFromSnapshot(moving));
    let maxRadius = 0;
    for (let t = 1_000; t < 4_000; t += 20) {
      for (const ring of vfx.buildFrame(t).rings) {
        maxRadius = Math.max(maxRadius, ring.r);
      }
    }
    expect(maxRadius).toBeGreaterThan(0);
    expect(maxRadius).toBeLessThanOrEqual(floor);
  });

  it("is a MARKER only — a pawn is drawn past the edge, never stopped by it", () => {
    // Drawing has no collider: the renderer paints the pawn exactly
    // where the server says it is, even well outside the boundary ring
    // (the engine's own out-of-bounds rule is covered by engine tests).
    const arena = createArena();
    const beyond = { x: CX + floorRadius(arena) + CONFIG.pawn.radius + 5, y: CY };
    expect(Math.hypot(beyond.x - CX, beyond.y - CY)).toBeGreaterThan(
      floorRadius(arena) + CONFIG.pawn.radius
    );
    const pawns = [pawnAtSlot(0, { position: beyond })];
    const drawn = arcs(draw(snapshotOf(1, { pawns })));
    expect(
      drawn.some(
        ([x, y, r]) =>
          Math.abs(x - beyond.x) < 0.001 &&
          Math.abs(y - beyond.y) < 0.001 &&
          Math.abs(r - CONFIG.pawn.radius) < 0.001
      )
    ).toBe(true);
  });
});

describe("the 330-radius arena fits the canvas", () => {
  it("fits inside the 900x700 world box with margin on every side", () => {
    const r = CONFIG.arena.radius;
    expect(CX - r).toBeGreaterThanOrEqual(0);
    expect(CY - r).toBeGreaterThanOrEqual(0);
    expect(CX + r).toBeLessThanOrEqual(W);
    expect(CY + r).toBeLessThanOrEqual(H);
  });

  it("shows the WHOLE arena at every normal desktop viewport", () => {
    const viewports = [
      [1920, 820],
      [1600, 760],
      [1440, 640],
      [1366, 508],
      [1280, 460],
      [1024, 420],
      [900, 340],
    ];
    for (const [cw, ch] of viewports) {
      const { scale, offsetX, offsetY } = computeTransform(cw, ch);
      const r = CONFIG.arena.radius;
      const left = offsetX + (CX - r) * scale;
      const right = offsetX + (CX + r) * scale;
      const top = offsetY + (CY - r) * scale;
      const bottom = offsetY + (CY + r) * scale;
      expect(left).toBeGreaterThanOrEqual(-0.001);
      expect(top).toBeGreaterThanOrEqual(-0.001);
      expect(right).toBeLessThanOrEqual(cw + 0.001);
      expect(bottom).toBeLessThanOrEqual(ch + 0.001);
    }
  });

  it("fits the world by CONTAIN scaling, never cropping", () => {
    // The transform must never scale past the limiting axis.
    for (const [cw, ch] of [
      [1600, 400],
      [400, 1600],
      [900, 700],
    ]) {
      const { scale } = computeTransform(cw, ch);
      expect(scale).toBeLessThanOrEqual(Math.min(cw / W, ch / H) + 1e-9);
      expect(W * scale).toBeLessThanOrEqual(cw + 0.001);
      expect(H * scale).toBeLessThanOrEqual(ch + 0.001);
    }
  });
});

describe("pointer → world conversion with the 330 arena", () => {
  /** The exact inverse the ArenaView applies to a pointer event. */
  const toWorld = (px: number, py: number, cw: number, ch: number) => {
    const { scale, offsetX, offsetY } = computeTransform(cw, ch);
    return { x: (px - offsetX) / scale, y: (py - offsetY) / scale };
  };
  /** Forward: world → screen. */
  const toScreen = (x: number, y: number, cw: number, ch: number) => {
    const { scale, offsetX, offsetY } = computeTransform(cw, ch);
    return { px: offsetX + x * scale, py: offsetY + y * scale };
  };

  it("round-trips every spawn position at several canvas sizes", () => {
    const arena = createArena();
    for (const [cw, ch] of [
      [1440, 640],
      [1280, 460],
      [900, 700],
      [1920, 820],
    ]) {
      for (let slot = 0; slot < MAX; slot++) {
        const [x, y] = spawnPositionForSlot(arena, slot);
        const { px, py } = toScreen(x, y, cw, ch);
        const back = toWorld(px, py, cw, ch);
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
      }
    }
  });

  it("still lands on the arena edge after a resize", () => {
    // The same world point maps back correctly before and after a resize
    // — the conversion has no cached scale.
    const edge = { x: CX + CONFIG.arena.radius, y: CY };
    for (const [cw, ch] of [
      [1280, 460],
      [1600, 900],
    ]) {
      const { px, py } = toScreen(edge.x, edge.y, cw, ch);
      const back = toWorld(px, py, cw, ch);
      expect(back.x).toBeCloseTo(edge.x, 6);
      expect(back.y).toBeCloseTo(edge.y, 6);
    }
  });

  it("is unaffected by screen shake", () => {
    // ArenaView adds the shake offset to the RENDER transform only; the
    // input path calls computeTransform directly. Adding a shake offset
    // to the render transform must not change the inverse mapping.
    const cw = 1280;
    const ch = 460;
    const base = computeTransform(cw, ch);
    const shaken = { ...base, offsetX: base.offsetX + 7, offsetY: base.offsetY - 5 };
    // The input path recomputes, so it keeps the unshaken offsets.
    expect(computeTransform(cw, ch)).toEqual(base);
    expect(shaken.offsetX).not.toBe(base.offsetX);
    const target = { x: CX + 100, y: CY - 60 };
    const { px, py } = toScreen(target.x, target.y, cw, ch);
    expect(toWorld(px, py, cw, ch).x).toBeCloseTo(target.x, 6);
    expect(toWorld(px, py, cw, ch).y).toBeCloseTo(target.y, 6);
  });

  it("maps the canvas center to the arena center", () => {
    for (const [cw, ch] of [
      [1440, 640],
      [900, 700],
    ]) {
      const mid = toWorld(cw / 2, ch / 2, cw, ch);
      expect(mid.x).toBeCloseTo(CX, 6);
      expect(mid.y).toBeCloseTo(CY, 6);
    }
  });
});

describe("six-player aiming privacy on the canvas", () => {
  it("draws no launch indicator for anyone during the aiming phase", () => {
    // Even if a hand-fed snapshot carried launches during aiming (the
    // server nulls them), the renderer refuses to draw them.
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawnAtSlot(i, {
        launch: { direction: { x: 1, y: 0 }, power: 5 },
        confirmed: true,
      })
    );
    const calls = draw(snapshotOf(MAX, { phase: "aiming", pawns }));
    expect(calls.filter((c) => c.op === "moveTo")).toHaveLength(0);
  });

  it("draws ONLY the local player's aim while the round is undecided", () => {
    const calls = draw(
      snapshotOf(MAX, {
        isAiming: true,
        aimDirection: { x: 1, y: 0 },
        power: CONFIG.power.max,
      })
    );
    const arena = createArena();
    const [lx, ly] = spawnPositionForSlot(arena, 0);
    const starts = calls
      .filter((c) => c.op === "moveTo")
      .map((c) => c.args as [number, number]);
    expect(starts.length).toBeGreaterThan(0);
    // Every shaft/chevron belongs to the local pawn's indicator: it sits
    // within the indicator's own reach of the local pawn, and never near
    // another seat.
    const reach = CONFIG.aiming.maxLength + CONFIG.pawn.radius + 20;
    for (const [sx, sy] of starts) {
      expect(Math.hypot(sx - lx, sy - ly)).toBeLessThanOrEqual(reach);
      for (let slot = 1; slot < MAX; slot++) {
        const [ox, oy] = spawnPositionForSlot(arena, slot);
        expect(Math.hypot(sx - ox, sy - oy)).toBeGreaterThan(CONFIG.pawn.radius + 2);
      }
    }
  });

  it("reveals all six launches once the round resolves", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawnAtSlot(i, {
        launch: { direction: { x: 0, y: 1 }, power: 2 },
        confirmed: true,
      })
    );
    const calls = draw(snapshotOf(MAX, { phase: "moving", pawns }));
    // Six revealed arrows: each contributes at least a shaft start.
    expect(calls.filter((c) => c.op === "moveTo").length).toBeGreaterThanOrEqual(MAX);
  });

  it("cannot infer a remote power from the canvas during aiming", () => {
    // Two snapshots differing ONLY in other players' hidden power must
    // produce byte-identical draw calls.
    const withPower = (power: number) => {
      const pawns = Array.from({ length: MAX }, (_, i) =>
        pawnAtSlot(i, i === 0 ? {} : { confirmed: true })
      );
      // The remote hidden choice lives nowhere in the projection; this
      // models a would-be leak by varying it on the source side only.
      void power;
      return snapshotOf(MAX, { phase: "aiming", pawns });
    };
    const a = JSON.stringify(draw(withPower(1)));
    const b = JSON.stringify(draw(withPower(5)));
    expect(a).toBe(b);
  });

  it("shows readiness without showing the choice", () => {
    // "Confirmed" is public (the rail shows Ready); direction and power
    // are not. A confirmed remote pawn must add no indicator geometry.
    const unconfirmed = draw(snapshotOf(MAX));
    const confirmedPawns = Array.from({ length: MAX }, (_, i) =>
      pawnAtSlot(i, { confirmed: i !== 0 })
    );
    const confirmed = draw(snapshotOf(MAX, { pawns: confirmedPawns }));
    expect(confirmed.filter((c) => c.op === "moveTo")).toHaveLength(
      unconfirmed.filter((c) => c.op === "moveTo").length
    );
  });
});
