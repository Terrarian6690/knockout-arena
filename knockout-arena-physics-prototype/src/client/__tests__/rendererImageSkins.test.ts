// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  CONFIG,
  createArena,
  playerColor,
  type GameStateSnapshot,
  type PawnSnapshot,
} from "../../game";
import { computeTransform, render } from "../renderer";

/**
 * Image skins on the CANVAS: the pawn's body is the LARGEST CENTERED
 * CIRCLE of the asset — the centered square of its shorter side drawn
 * inside the pawn's circle clip. While the asset has not decoded (or
 * if it never does) the pawn keeps its palette color — a disc is never
 * blank and the board never waits on an image.
 */

const ARENA = createArena();

interface Call {
  op: string;
  args: unknown[];
}

function recordingCtx() {
  const calls: Call[] = [];
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
    "clip",
    "drawImage",
    "setLineDash",
    "moveTo",
    "lineTo",
  ];
  const target: Record<string, unknown> = {
    canvas: { width: 900, height: 700 },
    createRadialGradient: () => ({ addColorStop: () => {} }),
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

function pawnView(
  id: string,
  overrides: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name: `Player ${id}`,
    position: { x: 450, y: 350 },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: id === "p0",
    colorIndex: 0,
    ...overrides,
  };
}

function snap(colorIndex: number): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: [pawnView("p0", { colorIndex })],
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
  };
}

function draw(colorIndex: number): Call[] {
  const { ctx, calls } = recordingCtx();
  render(ctx, snap(colorIndex), ARENA, computeTransform(900, 700));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderer — image-skin pawns", () => {
  it("falls back to the wrapped palette color while the asset loads", () => {
    // jsdom's Image never decodes: naturalWidth stays 0.
    const calls = draw(101); // the secret troll skin
    const fill = calls.filter((c) => c.op === "set:fillStyle");
    expect(fill).toContainEqual({
      op: "set:fillStyle",
      args: [playerColor(101)], // palette[101 % 6] — never blank
    });
    expect(calls.some((c) => c.op === "drawImage")).toBe(false);
  });

  it("a decoded asset draws its centered square inside the pawn's clip", () => {
    class FakeImage {
      complete = true;
      naturalWidth = 256;
      naturalHeight = 128; // deliberately NOT square: crop picks 128
      src = "data:image/png;base64,fake";
    }
    vi.stubGlobal("Image", FakeImage);

    const calls = draw(102); // the secret moai skin
    const clip = calls.findIndex((c) => c.op === "clip");
    const image = calls.find((c) => c.op === "drawImage")!;
    expect(clip).toBeGreaterThan(-1);
    expect(image).toBeTruthy();
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = image.args as number[];
    // Source: the CENTERED SQUARE of the shorter side (128×128 at 64,0).
    expect([sw, sh]).toEqual([128, 128]);
    expect(sx).toBe(64);
    expect(sy).toBe(0);
    // Destination: the pawn's bounding box, after the clip.
    const r = CONFIG.pawn.radius;
    expect([dx, dy, dw, dh]).toEqual([450 - r, 350 - r, r * 2, r * 2]);
    // The clip belongs to the pawn's circle, opened just before.
    const arcBefore = calls
      .slice(0, clip)
      .reverse()
      .find((c) => c.op === "arc");
    expect(arcBefore).toBeTruthy();
    // Palette pawns remain plain fills — no clip, no drawImage.
    const plain = draw(2);
    expect(plain.some((c) => c.op === "drawImage")).toBe(false);
  });
});
