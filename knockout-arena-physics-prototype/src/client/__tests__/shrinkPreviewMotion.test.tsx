// @vitest-environment jsdom
import "./lobbyTestHarness"; // ResizeObserver stub (jsdom ships none)
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ArenaView, SHRINK_PULSE_PERIOD_MS } from "../components/game/ArenaView";
import { render as renderSnapshot } from "../renderer";
import type { ArenaSnapshot, GameStateSnapshot, PawnSnapshot } from "../../game";
import { CONFIG } from "../../game";

/**
 * TASK 30 at the COMPONENT level: the pulse the arena feeds the renderer.
 *
 * The pure-renderer tests (shrinkPreviewRing.test.ts) pin what a given
 * pulse draws. This file pins the two things only the component decides:
 *
 *   - the pulse oscillates over time while a shrink is imminent, which
 *     requires the frame-skip optimisation to keep repainting;
 *   - `prefers-reduced-motion` pins it to full strength — the ring is
 *     still drawn, at the same radius, it simply does not move.
 */

vi.mock("../renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer")>();
  return { ...actual, render: vi.fn(() => {}) };
});

/** Every pulse value (6th argument) handed to the renderer so far. */
function pulses(): number[] {
  return vi
    .mocked(renderSnapshot)
    .mock.calls.map((c) => (c as unknown[])[5] as number);
}

let clockNow = 0;
const clock = vi.spyOn(performance, "now").mockImplementation(() => clockNow);
const at = (t: number) => {
  clockNow = t;
};

type FrameCallback = (time: number) => void;
let frames: FrameCallback[] = [];
/** Run every queued rAF callback once (the loop re-queues itself). */
function flushFrame() {
  const queued = frames;
  frames = [];
  for (const cb of queued) cb(clockNow);
}

let reducedMotion = false;

beforeAll(() => {
  (window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
    (cb: FrameCallback) => {
      frames.push(cb);
      return frames.length;
    };
  (window as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame =
    () => {};

  const fakeContext = { setTransform: () => {} } as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() =>
    fakeContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
    get: () => 800,
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
    get: () => 600,
    configurable: true,
  });
  (window as unknown as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
});

afterEach(() => {
  cleanup();
  frames = [];
  reducedMotion = false;
  vi.mocked(renderSnapshot).mockClear();
});

afterAll(() => {
  clock.mockRestore();
});

function pawn(id: string): PawnSnapshot {
  return {
    id,
    name: id,
    position: { x: CONFIG.arena.centerX, y: CONFIG.arena.centerY },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: true,
    colorIndex: 0,
  };
}

function arenaSnap(warning: boolean): ArenaSnapshot {
  return {
    radius: CONFIG.arena.radius,
    roundsUntilShrink: warning ? 1 : 3,
    nextRadius: CONFIG.arena.radius - CONFIG.arena.shrink.amount,
    shrinkWarning: warning,
    atMinRadius: false,
  };
}

function snapshot(warning: boolean): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: [pawn("p0")],
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
    arena: arenaSnap(warning),
  };
}

function mount(warning: boolean) {
  return render(
    <ArenaView snapshot={snapshot(warning)} interactive onAim={() => {}} />
  );
}

describe("the preview pulse at the component level", () => {
  it("varies over time while a shrink is imminent", () => {
    at(0);
    mount(true);
    // Advance through one full period; the frame-skip must not freeze it.
    for (const t of [0, 200, 400, 600, 800, 1000, 1200, 1400]) {
      at(t);
      flushFrame();
    }
    const seen = pulses().filter((p) => typeof p === "number");
    expect(seen.length).toBeGreaterThan(3);
    expect(new Set(seen.map((p) => p.toFixed(3))).size).toBeGreaterThan(3);
    // It reaches both ends of its range: full intensity and (near) zero.
    expect(Math.max(...seen)).toBeGreaterThan(0.9);
    expect(Math.min(...seen)).toBeLessThan(0.1);
  });

  it("keeps repainting even though the snapshot object never changes", () => {
    // Without the preview being treated as activity, the identical-frame
    // check would skip these repaints and the ring would sit frozen.
    at(0);
    mount(true);
    const before = vi.mocked(renderSnapshot).mock.calls.length;
    for (const t of [100, 200, 300, 400]) {
      at(t);
      flushFrame();
    }
    expect(vi.mocked(renderSnapshot).mock.calls.length).toBeGreaterThan(before);
  });

  it("does not force repaints when no shrink is imminent", () => {
    // The optimisation still holds for ordinary rounds: a static scene
    // costs nothing extra.
    at(0);
    mount(false);
    const settled = vi.mocked(renderSnapshot).mock.calls.length;
    for (const t of [100, 200, 300, 400]) {
      at(t);
      flushFrame();
    }
    expect(vi.mocked(renderSnapshot).mock.calls.length).toBe(settled);
  });

  it("pins the pulse to full strength under prefers-reduced-motion", () => {
    reducedMotion = true;
    at(0);
    const view = mount(true);

    // Force a real repaint at each instant by pushing a FRESH snapshot
    // object: the frame-skip would otherwise swallow these draws (a
    // still ring needs no repaints), and the test would only ever see
    // the mount frame — where the animated pulse happens to be 1.0 too,
    // and so could not tell the two apart.
    for (const t of [400, 800, SHRINK_PULSE_PERIOD_MS / 2, 1200]) {
      at(t);
      view.rerender(
        <ArenaView snapshot={snapshot(true)} interactive onAim={() => {}} />
      );
      flushFrame();
    }

    const seen = pulses().filter((p) => typeof p === "number");
    // Several genuinely distinct instants, all at full intensity —
    // including t=800, where the animation would have faded the ring
    // out completely.
    expect(seen.length).toBeGreaterThan(3);
    for (const p of seen) expect(p).toBe(1);
  });

  it("DOES vary at those same instants when motion is allowed", () => {
    // The control for the test above: same instants, same forced
    // repaints, motion enabled — proving the assertion above is about
    // reduced motion and not about the repaint plumbing.
    reducedMotion = false;
    at(0);
    const view = mount(true);
    for (const t of [400, 800, SHRINK_PULSE_PERIOD_MS / 2, 1200]) {
      at(t);
      view.rerender(
        <ArenaView snapshot={snapshot(true)} interactive onAim={() => {}} />
      );
      flushFrame();
    }
    const seen = pulses().filter((p) => typeof p === "number");
    expect(seen.some((p) => p < 0.9)).toBe(true);
    expect(seen.some((p) => p < 0.05)).toBe(true);
  });

  it("still draws the arena under reduced motion (no repaint storm)", () => {
    reducedMotion = true;
    at(0);
    mount(true);
    const settled = vi.mocked(renderSnapshot).mock.calls.length;
    expect(settled).toBeGreaterThan(0);
    for (const t of [100, 200, 300]) {
      at(t);
      flushFrame();
    }
    // A constant ring needs no extra frames.
    expect(vi.mocked(renderSnapshot).mock.calls.length).toBe(settled);
  });
});
