import { describe, expect, it } from "vitest";
import {
  CONFIG,
  createArena,
  indicatorLength,
  playerColor,
  type GameStateSnapshot,
  type PawnSnapshot,
  type Vec2,
} from "../../game";
import { computeTransform, render } from "../renderer";

/**
 * The ARROW geometry of the aiming UX, pinned against the pure renderer
 * with a recording 2D context (no canvas, no DOM — the renderer is a pure
 * function of the snapshot):
 *
 *  - the LOCAL aim arrow originates at the local pawn's center, points
 *    along the projected aimDirection, and its length grows monotonically
 *    with power 1→5 (Task 13 labels 5, 20);
 *  - during aiming exactly ONE dashed arrow exists (the viewer's own) —
 *    there is no data from which any other arrow could be drawn;
 *  - during moving, every pawn with a committed launch gets one arrow,
 *    attached to that pawn, in that player's color, with the length of
 *    the confirmed power (the reveal); pawns without a launch get none
 *    (13), and no launch arrow is drawn during aiming even if a crafted
 *    snapshot carries one (defense in depth).
 */

const ARENA = createArena();

/** One recorded context call (method or property assignment). */
interface Call {
  op: string;
  args: unknown[];
}

/** A CanvasRenderingContext2D stand-in that records everything. */
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

/**
 * Every arrow shaft tip, in draw order.
 *
 * The shaft used to be identifiable by its dash pattern; the arrow is
 * now ONE CONTINUOUS stroke, so it is identified by its width instead:
 * a beginPath → moveTo → lineTo → lineWidth = SHAFT_WIDTH → stroke
 * sequence. The lineTo argument is the arrow tip, in WORLD coordinates
 * (the recorder sees through the canvas transform).
 *
 * Scanning for the stroke that CLOSES each path keeps this honest: the
 * arrowhead is filled, not stroked, so it cannot be mistaken for a
 * shaft, and no other stroked geometry in the scene uses this width.
 */
const SHAFT_WIDTH = 2.5;

function arrowTips(calls: Call[]): Array<{ x: number; y: number; color: string }> {
  const tips: Array<{ x: number; y: number; color: string }> = [];
  for (let i = 0; i < calls.length; i++) {
    if (calls[i].op !== "beginPath") continue;
    // Walk this path's calls up to the operation that ends it.
    let lineTo: Call | undefined;
    let width: number | undefined;
    let color = "";
    let stroked = false;
    for (let j = i + 1; j < calls.length; j++) {
      const c = calls[j];
      if (c.op === "beginPath") break;
      if (c.op === "lineTo" && lineTo === undefined) lineTo = c;
      if (c.op === "set:lineWidth") width = Number(c.args[0]);
      if (c.op === "set:strokeStyle") color = String(c.args[0]);
      if (c.op === "fill") break; // a filled shape: the arrowhead
      if (c.op === "stroke") {
        stroked = true;
        break;
      }
    }
    if (!stroked || lineTo === undefined || width !== SHAFT_WIDTH) continue;
    const [x, y] = lineTo.args as [number, number];
    tips.push({ x, y, color });
  }
  return tips;
}

function pawnView(id: string, overrides: Partial<PawnSnapshot> = {}): PawnSnapshot {
  return {
    id,
    name: `Player ${id}`,
    position: { x: 300 + Number(id.slice(1)) * 300, y: 350 },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: id === "p0",
    colorIndex: Number(id.slice(1)),
    ...overrides,
  };
}

function snap(overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: [pawnView("p0"), pawnView("p1")],
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
    ...overrides,
  };
}

/** Draw a snapshot and return its recorded calls. */
function draw(snapshot: GameStateSnapshot): Call[] {
  const { ctx, calls } = recordingCtx();
  render(ctx, snapshot, ARENA, computeTransform(900, 700));
  return calls;
}

describe("renderer — the local aim arrow", () => {
  it("originates at the local pawn, follows the aim direction", () => {
    const local = { ...pawnView("p0", { position: { x: 400, y: 350 } }) };
    for (const [direction, expectTip] of [
      [{ x: 1, y: 0 }, (tip: Vec2) => tip.x > 400],
      [{ x: -1, y: 0 }, (tip: Vec2) => tip.x < 400],
      [{ x: 0, y: 1 }, (tip: Vec2) => tip.y > 350],
      [{ x: 0, y: -1 }, (tip: Vec2) => tip.y < 350],
    ] as const) {
      const tips = arrowTips(
        draw(
          snap({
            pawns: [local, pawnView("p1")],
            aimDirection: direction as Vec2,
            isAiming: true,
            power: 3,
          })
        )
      );
      expect(tips).toHaveLength(1); // exactly ONE arrow — the viewer's own
      expectTip(tips[0]);
      // The shaft starts at the pawn's edge and the tip is further out
      // along the direction — the arrow is attached to the pawn.
      expect(Math.hypot(tips[0].x - 400, tips[0].y - 350)).toBeGreaterThan(
        CONFIG.pawn.radius
      );
    }
  });

  it("arrow length grows strictly with power 1 → 5 (5, 20)", () => {
    const local = pawnView("p0", { position: { x: 400, y: 350 } });
    const lengths: number[] = [];
    for (const power of [1, 2, 3, 4, 5]) {
      const tips = arrowTips(
        draw(
          snap({
            pawns: [local, pawnView("p1")],
            aimDirection: { x: 1, y: 0 },
            isAiming: true,
            power,
          })
        )
      );
      expect(tips).toHaveLength(1);
      const length = tips[0].x - 400; // direction (1,0): length = Δx
      // The exact committed geometry: indicatorLength(power) past the rim
      // of the pawn (+ the small stand-off constants).
      expect(length).toBeCloseTo(
        indicatorLength(power) + CONFIG.pawn.radius + 4,
        6
      );
      lengths.push(length);
    }
    // Strictly increasing — power 1 is the shortest, power 5 the longest.
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
    }
    expect(lengths[0]).toBeLessThan(lengths[4]);
  });

  it("draws exactly one arrow during aiming even with several pawns on screen", () => {
    const tips = arrowTips(
      draw(
        snap({
          pawns: [
            pawnView("p0"),
            pawnView("p1"),
            pawnView("p2"),
            pawnView("p3"),
          ],
          aimDirection: { x: 0, y: 1 },
          isAiming: true,
        })
      )
    );
    expect(tips).toHaveLength(1); // everyone else's aim is not ours to see
    expect(tips[0].color).toBe(CONFIG.colors.aimLine); // the shared amber
  });
});

describe("renderer — the revealed launch arrows", () => {
  it("moving: every confirmed launcher gets an arrow at their pawn, in their color, sized by their power", () => {
    const p0 = pawnView("p0", {
      position: { x: 450, y: 110 },
      launch: { direction: { x: 0, y: 1 }, power: 2 },
    });
    const p1 = pawnView("p1", {
      position: { x: 450, y: 590 },
      launch: { direction: { x: 0, y: -1 }, power: 5 },
    });
    const tips = arrowTips(
      draw(snap({ phase: "moving", pawns: [p0, p1], isAiming: false }))
    );
    expect(tips).toHaveLength(2);
    // p0's arrow: down from (450,110), length for power 2, p0's color.
    expect(tips[0].x).toBeCloseTo(450, 6);
    expect(tips[0].y).toBeCloseTo(
      110 + indicatorLength(2) + CONFIG.pawn.radius + 4,
      6
    );
    expect(tips[0].color).toBe(playerColor(0));
    // p1's arrow: up from (450,590), length for power 5, p1's color.
    expect(tips[1].x).toBeCloseTo(450, 6);
    expect(tips[1].y).toBeCloseTo(
      590 - indicatorLength(5) - CONFIG.pawn.radius - 4,
      6
    );
    expect(tips[1].color).toBe(playerColor(1));
  });

  it("unconfirmed pawns get no arrow — never a guessed direction (13)", () => {
    const p0 = pawnView("p0", {
      position: { x: 450, y: 110 },
      launch: { direction: { x: 0, y: 1 }, power: 2 },
    });
    const p1 = pawnView("p1", { position: { x: 450, y: 590 } }); // silent
    const tips = arrowTips(
      draw(snap({ phase: "moving", pawns: [p0, p1] }))
    );
    expect(tips).toHaveLength(1); // only the confirmed launcher
    expect(tips[0].color).toBe(playerColor(0));
  });

  it("an aiming snapshot never draws launch arrows (the phase gate is defense in depth)", () => {
    // A crafted snapshot that should never exist: launch data during
    // aiming. The renderer must not draw it even then.
    const p0 = pawnView("p0", {
      launch: { direction: { x: 1, y: 0 }, power: 5 },
    });
    const p1 = pawnView("p1", {
      launch: { direction: { x: -1, y: 0 }, power: 5 },
    });
    const tips = arrowTips(
      draw(snap({ phase: "aiming", pawns: [p0, p1], isAiming: false }))
    );
    expect(tips).toHaveLength(0);
  });

  it("a finished match keeps the final round's arrows visible", () => {
    const p0 = pawnView("p0", {
      launch: { direction: { x: 1, y: 0 }, power: 4 },
    });
    const tips = arrowTips(
      draw(
        snap({
          phase: "finished",
          pawns: [p0, pawnView("p1")],
          winnerId: "p0",
        })
      )
    );
    expect(tips).toHaveLength(1);
    expect(tips[0].color).toBe(playerColor(0));
  });
});

/**
 * THE ARROW IS ONE CONTINUOUS SHAPE.
 *
 * It used to be a dashed shaft with a row of chevrons marching along it,
 * which read as a trail of separate marks rather than a single pointer.
 * Now it is a solid shaft plus a filled head — and that has to stay
 * true, because the old form is easy to reintroduce by accident (a
 * stray setLineDash, or a "power pips" feature bolted back on).
 */
describe("renderer — the aim arrow is one continuous shape", () => {
  const aiming = (power = 3) =>
    draw(
      snap({
        pawns: [pawnView("p0", { position: { x: 400, y: 350 } }), pawnView("p1")],
        aimDirection: { x: 1, y: 0 },
        isAiming: true,
        power,
      })
    );

  /** Calls belonging to the indicator: everything after the arena. */
  const dashPatterns = (calls: Call[]): number[][] =>
    calls
      .filter((c) => c.op === "setLineDash")
      .map((c) => c.args[0] as number[])
      .filter((d) => d.length > 0);

  it("draws the shaft with no dash pattern at all", () => {
    // The shrink preview ring legitimately dashes, so this asserts on
    // the shaft specifically: the last dash instruction before the
    // arrow is drawn must be the empty (solid) one, and no [8, 7]
    // pattern — the old shaft's signature — appears anywhere.
    const calls = aiming();
    for (const dash of dashPatterns(calls)) {
      expect(dash).not.toEqual([8, 7]);
    }
  });

  it("is exactly two pieces: one stroked shaft and one filled head", () => {
    const calls = aiming();
    // Exactly one stroke at the shaft's width — the shaft itself.
    const strokeWidths: number[] = [];
    let current: number | undefined;
    for (const c of calls) {
      if (c.op === "set:lineWidth") current = Number(c.args[0]);
      if (c.op === "stroke" && current !== undefined) strokeWidths.push(current);
    }
    expect(strokeWidths.filter((w) => w === SHAFT_WIDTH)).toHaveLength(1);

    // Nothing is drawn BETWEEN the shaft and its head. This is the real
    // guard: the chevrons lived exactly there, so any mark in that span
    // means the arrow has become a row of pieces again. (Scoping it to
    // the span matters — the pawn's own outline and highlight ring are
    // stroked later in the scene and are not part of the arrow.)
    const shaftStroke = (() => {
      let width: number | undefined;
      for (let i = 0; i < calls.length; i++) {
        if (calls[i].op === "set:lineWidth") width = Number(calls[i].args[0]);
        if (calls[i].op === "stroke" && width === SHAFT_WIDTH) return i;
      }
      return -1;
    })();
    expect(shaftStroke).toBeGreaterThan(-1);
    const headFill = calls.findIndex((c, i) => i > shaftStroke && c.op === "fill");
    expect(headFill).toBeGreaterThan(shaftStroke);
    const between = calls.slice(shaftStroke + 1, headFill);
    expect(between.filter((c) => c.op === "stroke")).toHaveLength(0);
    expect(between.filter((c) => c.op === "fill")).toHaveLength(0);
  });

  it("adds no extra marks as power grows", () => {
    // The old chevrons were spaced along the shaft, so a longer arrow
    // grew MORE of them. A continuous arrow must cost the same number
    // of drawing operations at every power — only its length changes.
    const shape = (power: number) => {
      const calls = aiming(power);
      return calls.filter((c) => c.op === "stroke" || c.op === "fill").length;
    };
    const atOne = shape(1);
    for (const power of [2, 3, 4, 5]) {
      expect(shape(power)).toBe(atOne);
    }
  });

  it("still lengthens with power (the cue the chevrons used to carry)", () => {
    // Removing the chevrons must not remove the power feedback: length
    // is now the whole signal, so it has to be strictly monotonic.
    const tipX = (power: number) => arrowTips(aiming(power))[0].x;
    const lengths = [1, 2, 3, 4, 5].map(tipX);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
    }
  });

  it("runs the shaft all the way to the tip, so head and shaft join", () => {
    // A gap between shaft and head would read as two shapes again. The
    // shaft's lineTo must be the same point the head's apex moveTo uses.
    const calls = aiming(5);
    const tip = arrowTips(calls)[0];
    // The head is the FILLED path drawn right after the shaft — search
    // from the shaft's stroke, not from the start of the scene (the
    // arena and the effects are filled shapes too).
    const shaftStroke = (() => {
      let width: number | undefined;
      for (let i = 0; i < calls.length; i++) {
        if (calls[i].op === "set:lineWidth") width = Number(calls[i].args[0]);
        if (calls[i].op === "stroke" && width === SHAFT_WIDTH) return i;
      }
      return -1;
    })();
    expect(shaftStroke).toBeGreaterThan(-1);
    const headStart = calls
      .slice(shaftStroke + 1)
      .find((c) => c.op === "moveTo");
    expect(headStart).toBeDefined();
    const [hx, hy] = headStart!.args as [number, number];
    expect(hx).toBeCloseTo(tip.x, 6);
    expect(hy).toBeCloseTo(tip.y, 6);
  });
});
