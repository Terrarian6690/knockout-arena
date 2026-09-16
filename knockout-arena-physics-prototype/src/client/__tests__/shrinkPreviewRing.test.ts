import { describe, expect, it } from "vitest";
import {
  CONFIG,
  arenaEdgeRadius,
  arenaFromSnapshot,
  createArena,
  floorRadius,
  type ArenaSnapshot,
  type GameStateSnapshot,
  type PawnSnapshot,
} from "../../game";
import { isPawnOutOfBounds, arenaShrinkView } from "../../game/arena";
import { render } from "../renderer";
import { shrinkPreviewPulse, SHRINK_PULSE_PERIOD_MS } from "../components/game/ArenaView";

/**
 * TASK 30 — the boundary ring is gone; a red dashed ring previews the
 * NEXT radius for exactly the round before each shrink.
 *
 * Pinned against the pure renderer with a recording 2D context: the arcs
 * and style writes it emits are the drawing, so they are the proof.
 *
 * The rule under test is that every previewed circle is derived from the
 * AUTHORITATIVE snapshot (Section 16's standing rule, and the specific
 * stale-geometry bug fixed there): the client owns no shrink schedule,
 * no round counter and no remembered radius.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const INITIAL = CONFIG.arena.radius;
const MIN = CONFIG.arena.shrink.minRadius;
const STEP = CONFIG.arena.shrink.amount;
const RED = CONFIG.colors.outOfBounds;
/** 330 → 290 → 250 → 210 → 180. */
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

/** Radii of every arc centered on the arena center. */
function arenaArcRadii(calls: Call[]): number[] {
  return calls
    .filter((c) => c.op === "arc")
    .map((c) => c.args as [number, number, number])
    .filter(([x, y]) => x === CX && y === CY)
    .map(([, , r]) => r);
}

/**
 * Radii of arcs stroked in the danger red — i.e. the preview rings.
 * Walks the call list in order so a stroke is attributed to the arc and
 * color that precede it, exactly as the canvas would apply them.
 */
function redDashedRingRadii(calls: Call[]): number[] {
  const found: number[] = [];
  let lastArc: [number, number, number] | null = null;
  let color: unknown = null;
  let dashed = false;
  for (const c of calls) {
    if (c.op === "arc") lastArc = c.args as [number, number, number];
    else if (c.op === "set:strokeStyle") color = c.args[0];
    else if (c.op === "setLineDash") {
      const pattern = c.args[0] as number[];
      dashed = Array.isArray(pattern) && pattern.length > 0;
    } else if (c.op === "stroke" && lastArc && color === RED && dashed) {
      found.push(lastArc[2]);
    }
  }
  return found;
}

/** The alpha in force at each red dashed stroke. */
function redRingAlphas(calls: Call[]): number[] {
  const out: number[] = [];
  let color: unknown = null;
  let alpha = 1;
  let dashed = false;
  for (const c of calls) {
    if (c.op === "set:strokeStyle") color = c.args[0];
    else if (c.op === "set:globalAlpha") alpha = c.args[0] as number;
    else if (c.op === "setLineDash") {
      const p = c.args[0] as number[];
      dashed = Array.isArray(p) && p.length > 0;
    } else if (c.op === "stroke" && color === RED && dashed) out.push(alpha);
  }
  return out;
}

function pawn(id: string): PawnSnapshot {
  return {
    id,
    name: id,
    position: { x: CX, y: CY },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: id === "p0",
    colorIndex: 0,
  };
}

/**
 * Build the arena projection the SERVER would send for a given radius and
 * number of completed rounds since the last shrink — via the engine's own
 * projection helper, so these tests cannot drift from the real schedule.
 */
function arenaSnapshotFor(radius: number, roundsSinceShrink: number): ArenaSnapshot {
  const view = arenaShrinkView(radius, roundsSinceShrink);
  return {
    radius,
    roundsUntilShrink: view.roundsUntilShrink,
    nextRadius: view.nextRadius,
    // The engine gates the warning on the aiming phase; these snapshots
    // are all aiming-phase.
    shrinkWarning: view.warning,
    atMinRadius: radius <= MIN,
  };
}

function snap(arena: ArenaSnapshot | null): GameStateSnapshot {
  const base: GameStateSnapshot = {
    phase: "aiming",
    pawns: [pawn("p0")],
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
  };
  return arena === null ? base : { ...base, arena };
}

/** Draw a snapshot exactly the way the app does. */
function draw(snapshot: GameStateSnapshot, pulse?: number) {
  const { ctx, calls } = recordingCtx();
  render(
    ctx,
    snapshot,
    arenaFromSnapshot(snapshot),
    { scale: 1, offsetX: 0, offsetY: 0 },
    undefined,
    pulse
  );
  return calls;
}

describe("the white boundary ring is gone", () => {
  it("strokes no ring at the arena edge during an ordinary round", () => {
    // Two rounds before a shrink: nothing imminent, so nothing drawn.
    const calls = draw(snap(arenaSnapshotFor(INITIAL, 1)));
    expect(redDashedRingRadii(calls)).toEqual([]);

    // The old ring was a #7ea8d1 stroke plus a faint rgba outer line.
    const strokeColors = calls
      .filter((c) => c.op === "set:strokeStyle")
      .map((c) => String(c.args[0]));
    expect(strokeColors).not.toContain(CONFIG.colors.arenaWallGlow);
    expect(strokeColors.some((c) => c.includes("126,168,209"))).toBe(false);
  });

  it("no longer fills the opaque boundary band", () => {
    const fills = draw(snap(arenaSnapshotFor(INITIAL, 0)))
      .filter((c) => c.op === "set:fillStyle")
      .map((c) => c.args[0]);
    expect(fills).not.toContain(CONFIG.colors.arenaWall);
  });

  it("draws the floor out to the LETHAL edge, not the old floor circle", () => {
    // The heart of the change: one circle, and it is the one that kills.
    for (const radius of SCHEDULE) {
      const radii = arenaArcRadii(draw(snap(arenaSnapshotFor(radius, 0))));
      const arena = createArena(radius);
      expect(radii).toContain(arenaEdgeRadius(arena));
      expect(radii).not.toContain(floorRadius(arena));
    }
  });

  it("puts the visible edge exactly where a pawn dies, at every radius", () => {
    for (const radius of SCHEDULE) {
      const arena = createArena(radius);
      const edge = arenaEdgeRadius(arena);
      expect(arenaArcRadii(draw(snap(arenaSnapshotFor(radius, 0))))).toContain(
        edge
      );
      // Straddle the drawn edge with the real elimination rule.
      expect(isPawnOutOfBounds(arena, CX + edge - 0.5, CY, CONFIG.pawn.radius)).toBe(
        false
      );
      expect(isPawnOutOfBounds(arena, CX + edge + 0.5, CY, CONFIG.pawn.radius)).toBe(
        true
      );
    }
  });
});

describe("the red dashed preview ring", () => {
  it("appears the round before a shrink, at the NEXT radius", () => {
    // roundsSinceShrink = everyRounds - 1 → this round's completion
    // triggers the shrink.
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    const calls = draw(snap(arenaSnapshotFor(INITIAL, warnRound)));
    const rings = redDashedRingRadii(calls);

    expect(rings).toHaveLength(1);
    expect(rings[0]).toBe(arenaEdgeRadius(createArena(INITIAL - STEP)));
  });

  it("previews every transition in the real schedule", () => {
    // 330→290, 290→250, 250→210, 210→180.
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    for (let i = 0; i < SCHEDULE.length - 1; i += 1) {
      const from = SCHEDULE[i]!;
      const to = SCHEDULE[i + 1]!;
      const rings = redDashedRingRadii(
        draw(snap(arenaSnapshotFor(from, warnRound)))
      );
      expect(rings).toEqual([arenaEdgeRadius(createArena(to))]);
      // The preview is strictly inside the current edge.
      expect(rings[0]!).toBeLessThan(arenaEdgeRadius(createArena(from)));
    }
  });

  it("is centered with the same geometry as the arena", () => {
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    const calls = draw(snap(arenaSnapshotFor(250, warnRound)));
    const target = arenaEdgeRadius(createArena(210));
    const arcs = calls
      .filter((c) => c.op === "arc")
      .map((c) => c.args as [number, number, number])
      .filter(([, , r]) => r === target);
    expect(arcs.length).toBeGreaterThan(0);
    for (const [x, y] of arcs) {
      expect(x).toBe(CX);
      expect(y).toBe(CY);
    }
  });

  it("is dashed and uses the design system's danger red", () => {
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    const calls = draw(snap(arenaSnapshotFor(INITIAL, warnRound)));
    const dashes = calls
      .filter((c) => c.op === "setLineDash")
      .map((c) => c.args[0] as number[])
      .filter((p) => p.length > 0);

    expect(dashes.length).toBeGreaterThan(0);
    expect(dashes[0]!.every((n) => n > 0)).toBe(true);
    expect(
      calls
        .filter((c) => c.op === "set:strokeStyle")
        .map((c) => c.args[0])
    ).toContain(RED);
    expect(RED).toBe("#ef4444");
  });

  it("does NOT render when the shrink is further away", () => {
    for (let since = 0; since < CONFIG.arena.shrink.everyRounds - 1; since += 1) {
      expect(
        redDashedRingRadii(draw(snap(arenaSnapshotFor(INITIAL, since))))
      ).toEqual([]);
    }
  });

  it("disappears the moment the shrink lands", () => {
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    // Warned at 330…
    const before = draw(snap(arenaSnapshotFor(INITIAL, warnRound)));
    expect(redDashedRingRadii(before)).toHaveLength(1);

    // …then the shrink resolves: radius is now 290 and the counter reset.
    const after = draw(snap(arenaSnapshotFor(INITIAL - STEP, 0)));
    expect(redDashedRingRadii(after)).toEqual([]);
    // No leftover preview circle at the just-previewed radius, and the
    // floor is drawn at the NEW size.
    const radii = arenaArcRadii(after);
    expect(radii).toContain(arenaEdgeRadius(createArena(INITIAL - STEP)));
    expect(radii).not.toContain(arenaEdgeRadius(createArena(INITIAL)));
  });

  it("never renders at the minimum radius, however many rounds pass", () => {
    // The schedule keeps ticking at the floor size; nothing may be
    // previewed because nothing will shrink.
    for (const since of [0, 1, 2, 3, 6, 12]) {
      const arena = arenaSnapshotFor(MIN, since);
      expect(arena.nextRadius).toBeNull();
      expect(arena.shrinkWarning).toBe(false);
      expect(redDashedRingRadii(draw(snap(arena)))).toEqual([]);
    }
  });

  it("ignores a malformed nextRadius rather than drawing a bogus ring", () => {
    // Defense in depth for hand-fed snapshots: warning set, radius junk.
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const calls = draw(
        snap({
          radius: INITIAL,
          roundsUntilShrink: 1,
          nextRadius: bad as unknown as number | null,
          shrinkWarning: true,
          atMinRadius: false,
        })
      );
      expect(redDashedRingRadii(calls)).toEqual([]);
    }
  });
});

describe("the preview is derived from AUTHORITATIVE state, never frozen", () => {
  it("follows the snapshot when the round advances mid-session", () => {
    // Section 16's bug class: geometry captured once and reused. The
    // renderer is handed a fresh snapshot each frame and must track it.
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;

    // Round 1 of the cycle: no preview.
    expect(
      redDashedRingRadii(draw(snap(arenaSnapshotFor(INITIAL, 0))))
    ).toEqual([]);
    // Round 3: preview at 290's edge.
    expect(
      redDashedRingRadii(draw(snap(arenaSnapshotFor(INITIAL, warnRound))))
    ).toEqual([arenaEdgeRadius(createArena(INITIAL - STEP))]);
    // Shrink lands: gone.
    expect(
      redDashedRingRadii(draw(snap(arenaSnapshotFor(INITIAL - STEP, 0))))
    ).toEqual([]);
    // Next cycle warns again, now one step smaller.
    expect(
      redDashedRingRadii(draw(snap(arenaSnapshotFor(INITIAL - STEP, warnRound))))
    ).toEqual([arenaEdgeRadius(createArena(INITIAL - 2 * STEP))]);
  });

  it("uses the snapshot's own nextRadius, not a client-side computation", () => {
    // A snapshot whose nextRadius disagrees with the default schedule
    // must still be obeyed: the server is the authority, so the drawn
    // ring follows the wire value rather than any local arithmetic.
    const calls = draw(
      snap({
        radius: 300,
        roundsUntilShrink: 1,
        nextRadius: 220,
        shrinkWarning: true,
        atMinRadius: false,
      })
    );
    expect(redDashedRingRadii(calls)).toEqual([
      arenaEdgeRadius(createArena(220)),
    ]);
  });

  it("clamps an out-of-range nextRadius through the shared arena helper", () => {
    // createArena() clamps to the legal range, so a hostile snapshot
    // cannot make the client draw an arena the rules disallow.
    const calls = draw(
      snap({
        radius: INITIAL,
        roundsUntilShrink: 1,
        nextRadius: 5,
        shrinkWarning: true,
        atMinRadius: false,
      })
    );
    expect(redDashedRingRadii(calls)).toEqual([
      arenaEdgeRadius(createArena(MIN)),
    ]);
  });

  it("draws nothing extra for a snapshot with no arena field", () => {
    const calls = draw(snap(null));
    expect(redDashedRingRadii(calls)).toEqual([]);
    expect(arenaArcRadii(calls)).toContain(arenaEdgeRadius(createArena()));
  });
});

describe("the pulse", () => {
  it("oscillates between full intensity and complete absence", () => {
    expect(shrinkPreviewPulse(0)).toBeCloseTo(1, 5);
    expect(shrinkPreviewPulse(SHRINK_PULSE_PERIOD_MS / 2)).toBeCloseTo(0, 5);
    expect(shrinkPreviewPulse(SHRINK_PULSE_PERIOD_MS)).toBeCloseTo(1, 5);
  });

  it("stays within 0..1 and repeats every period", () => {
    for (let t = 0; t <= SHRINK_PULSE_PERIOD_MS * 2; t += 37) {
      const v = shrinkPreviewPulse(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(shrinkPreviewPulse(t + SHRINK_PULSE_PERIOD_MS)).toBeCloseTo(v, 6);
    }
  });

  it("changes only the ring's opacity, never its radius", () => {
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    const target = arenaEdgeRadius(createArena(INITIAL - STEP));
    for (const pulse of [1, 0.75, 0.5, 0.25]) {
      const calls = draw(snap(arenaSnapshotFor(INITIAL, warnRound)), pulse);
      expect(redDashedRingRadii(calls)).toEqual([target]);
      expect(redRingAlphas(calls)).toEqual([pulse]);
    }
  });

  it("skips the stroke entirely at zero intensity", () => {
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    const calls = draw(snap(arenaSnapshotFor(INITIAL, warnRound)), 0);
    expect(redDashedRingRadii(calls)).toEqual([]);
    // The arena itself is still drawn.
    expect(arenaArcRadii(calls)).toContain(arenaEdgeRadius(createArena(INITIAL)));
  });

  it("defaults to full strength when no pulse is supplied", () => {
    // Reduced-motion callers pass 1; callers that pass nothing (the solo
    // screen) must get a fully visible ring rather than an invisible one.
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    expect(redRingAlphas(draw(snap(arenaSnapshotFor(INITIAL, warnRound))))).toEqual([
      1,
    ]);
  });

  it("leaves no dash or alpha state behind for later drawing", () => {
    // A leaked setLineDash would dash the pawns; a leaked alpha would
    // fade them.
    const warnRound = CONFIG.arena.shrink.everyRounds - 1;
    const calls = draw(snap(arenaSnapshotFor(INITIAL, warnRound)), 0.4);
    const dashOps = calls.filter((c) => c.op === "setLineDash");
    const lastDash = dashOps[dashOps.length - 1]!.args[0] as number[];
    expect(lastDash).toEqual([]);
    const alphaOps = calls.filter((c) => c.op === "set:globalAlpha");
    expect(alphaOps[alphaOps.length - 1]!.args[0]).toBe(1);
  });
});
