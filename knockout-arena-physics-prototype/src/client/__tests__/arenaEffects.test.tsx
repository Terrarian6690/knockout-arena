// @vitest-environment jsdom
import "./lobbyTestHarness"; // ResizeObserver stub (jsdom ships none)
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ArenaView } from "../components/game/ArenaView";
import { computeTransform, render as renderSnapshot } from "../renderer";
import type { EffectFrame } from "../effects";
import type { GamePhase, GameStateSnapshot, PawnSnapshot } from "../../game";

/**
 * The VFX pipeline wired end-to-end at the component level (Task 18):
 * every authoritative push is diffed (launch bursts, round-start pulse,
 * elimination burst + shake, winner celebration), the baked effect frame
 * is handed to the renderer UNDER the pawns, and screen shake rides the
 * RENDER transform only — the pointer → world conversion (aiming!) never
 * sees it. Renderer module-mocked; performance.now scripted; the rAF loop
 * is a manual queue (draws here are push-driven, like jsdom always was).
 */

vi.mock("../renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer")>();
  return { ...actual, render: vi.fn(() => {}) };
});

function lastCall(): unknown[] {
  const calls = vi.mocked(renderSnapshot).mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("the arena never drew");
  return last as unknown[];
}

/** The effect frame handed to the renderer (5th argument). */
function lastEffects(): EffectFrame {
  return lastCall()[4] as EffectFrame;
}

/** The render transform (4th argument) — possibly shaken. */
function lastTransform(): { scale: number; offsetX: number; offsetY: number } {
  return lastCall()[3] as { scale: number; offsetX: number; offsetY: number };
}

// --- The scripted clock (performance.now is the VFX + interpolation clock). ---
let clockNow = 0;
const clock = vi.spyOn(performance, "now").mockImplementation(() => clockNow);
const at = (t: number) => {
  clockNow = t;
};

// --- The manual rAF queue (jsdom ships no requestAnimationFrame). ---
type FrameCallback = (time: number) => void;
let frames: FrameCallback[] = [];

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
  // A reduced-motion-agnostic default: full motion (overridden per test).
  (window as unknown as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: false,
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
  vi.mocked(renderSnapshot).mockClear();
});

afterAll(() => {
  clock.mockRestore();
});

// --- Snapshot builders. ---
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
  phase: GamePhase,
  pawns: PawnSnapshot[],
  overrides: Partial<GameStateSnapshot> = {}
): GameStateSnapshot {
  return {
    phase,
    pawns,
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: phase === "aiming" ? { x: 1, y: 0 } : null,
    isAiming: phase === "aiming",
    ...overrides,
  };
}

function aiming(): GameStateSnapshot {
  return state("aiming", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 500, 350)]);
}

function resolving(p1: Partial<PawnSnapshot> = {}): GameStateSnapshot {
  return state("moving", [
    pawnAt("p0", 300, 350, { isLocal: true, launch: { direction: { x: 1, y: 0 }, power: 3 } }),
    pawnAt("p1", 500, 350, { launch: { direction: { x: -1, y: 0 }, power: 3 }, ...p1 }),
  ]);
}

function mountArena(initial: GameStateSnapshot, onAim?: (p: { x: number; y: number }) => void) {
  const aim = onAim ?? (() => {});
  const props = { interactive: onAim !== undefined, onAim: aim };
  const view = render(<ArenaView snapshot={initial} {...props} />);
  return {
    canvas: view.container.querySelector("canvas")!,
    feed(next: GameStateSnapshot) {
      view.rerender(<ArenaView snapshot={next} {...props} />);
    },
  };
}

describe("arena visual effects", () => {
  it("launch + round-start effects fire on the aiming → moving push", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    const effects = lastEffects();
    // One round-start ring from the arena center + launch particles.
    expect(effects.rings).toHaveLength(1);
    expect(effects.particles.length).toBeGreaterThan(0);
    // A re-push of the same resolving state adds nothing.
    at(1116);
    arena.feed(resolving());
    expect(lastEffects().rings).toHaveLength(1);
  });

  it("movement trails follow the rendered (interpolated) pawn", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving()); // p1 starts at (500, 350) — baseline
    expect(lastEffects().trails).toHaveLength(0);
    at(1200);
    arena.feed(resolving({ position: { x: 600, y: 350 } }));
    // The rendered position at t=1150 is halfway (550) — a trail dot.
    const dots = lastEffects().trails;
    expect(dots.length).toBeGreaterThan(0);
    expect(dots[0]!.x).toBeCloseTo(550, 5);
  });

  it("elimination fires one burst at the authoritative position + shake", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    at(1200);
    arena.feed(resolving({ position: { x: 620, y: 350 }, eliminated: true }));
    const effects = lastEffects();
    // The elimination burst: exactly 20 particles around the AUTHORITATIVE
    // elimination position (launch particles from the round start, still
    // alive elsewhere, must not pollute this check), plus its ring there.
    const near = effects.particles.filter(
      (p) => Math.hypot(p.x - 620, p.y - 350) <= 20
    );
    expect(near).toHaveLength(20);
    expect(effects.rings.some((r) => r.x === 620 && r.y === 350)).toBe(true);
    // Screen shake rides the RENDER transform only, bounded by VFX.shakeMax.
    const base = computeTransform(800, 600);
    const t = lastTransform();
    expect(
      t.offsetX !== base.offsetX || t.offsetY !== base.offsetY
    ).toBe(true);
    expect(Math.abs(t.offsetX - base.offsetX)).toBeLessThanOrEqual(3);
    expect(Math.abs(t.offsetY - base.offsetY)).toBeLessThanOrEqual(3);
  });

  it("shake never alters the pointer → world aiming coordinates", () => {
    const aims: Array<{ x: number; y: number }> = [];
    at(1000);
    const arena = mountArena(aiming(), (p) => aims.push(p));
    at(1100);
    arena.feed(resolving());
    at(1200);
    arena.feed(resolving({ position: { x: 620, y: 350 }, eliminated: true }));
    // Shake is active right now (previous test proved the transform moved).
    fireEvent.pointerMove(arena.canvas, { clientX: 400, clientY: 300 });
    // The world point must be EXACTLY the unshaken transform's answer.
    const base = computeTransform(800, 600);
    expect(aims[aims.length - 1]).toEqual({
      x: (400 - base.offsetX) / base.scale,
      y: (300 - base.offsetY) / base.scale,
    });
  });

  it("effects do not cross round boundaries and resets clear them", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    expect(lastEffects().particles.length).toBeGreaterThan(0);
    // New round: back to aiming — everything transient is gone at once.
    at(1200);
    arena.feed(aiming());
    const cleared = lastEffects();
    expect(cleared.particles).toHaveLength(0);
    expect(cleared.rings).toHaveLength(0);
    expect(cleared.trails).toHaveLength(0);
  });

  it("the authoritative winner gets a celebration on the finished push", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    at(1200);
    arena.feed(
      state(
        "finished",
        [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 620, 350)],
        { winnerId: "p1" }
      )
    );
    const effects = lastEffects();
    expect(effects.particles.length).toBeGreaterThan(0);
    for (const p of effects.particles) {
      // Celebration originates AT the winner — nothing around the loser.
      expect(Math.hypot(p.x - 620, p.y - 350)).toBeLessThanOrEqual(2);
    }
    // A draw (winnerId null) celebrates nothing.
    at(1300);
    const arena2 = mountArena(aiming());
    at(1400);
    arena2.feed(resolving());
    at(1500);
    arena2.feed(
      state("finished", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 620, 350)], {
        winnerId: null,
      })
    );
    expect(lastEffects().particles).toHaveLength(0);
  });

  it("reduced motion: no shake, fewer particles", () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: true, // prefers-reduced-motion: reduce
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
    try {
      at(1000);
      const arena = mountArena(aiming());
      at(1100);
      arena.feed(resolving());
      // Launch bursts still communicate the event, roughly halved.
      const reducedLaunch = lastEffects().particles.length;
      expect(reducedLaunch).toBeGreaterThan(0);

      at(1200);
      arena.feed(resolving({ position: { x: 620, y: 350 }, eliminated: true }));
      const effects = lastEffects();
      expect(effects.particles.length).toBeGreaterThan(0);
      // No shake at all: the render transform stays exactly canonical.
      const base = computeTransform(800, 600);
      expect(lastTransform()).toEqual(base);
    } finally {
      (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      });
    }
  });
});
