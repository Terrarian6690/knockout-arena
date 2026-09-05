// @vitest-environment jsdom
import "./lobbyTestHarness"; // ResizeObserver stub (jsdom ships none)
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ArenaView } from "../components/game/ArenaView";
import { render as renderSnapshot } from "../renderer";
import { audio } from "../audio";
import type { GamePhase, GameStateSnapshot, PawnSnapshot } from "../../game";

/**
 * The audio wiring inside the arena (Task 22): every authoritative push
 * feeds the SINGLE event detector (Vfx.observe), whose events go to the
 * audio manager; a pointer press on the canvas unlocks audio. The audio
 * module is mocked here — these tests pin the WIRING (what reaches
 * audio.play / audio.unlock), not the synthesis (covered by
 * audio.test.ts). performance.now is scripted; renderer module-mocked.
 */

vi.mock("../renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer")>();
  return { ...actual, render: vi.fn(() => {}) };
});

vi.mock("../audio", () => ({
  audio: { play: vi.fn(), unlock: vi.fn() },
}));

const plays = () => vi.mocked(audio.play).mock.calls;
const unlocks = () => vi.mocked(audio.unlock).mock.calls;

let clockNow = 0;
const clock = vi.spyOn(performance, "now").mockImplementation(() => clockNow);
const at = (t: number) => {
  clockNow = t;
};

beforeAll(() => {
  (window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
    () => 1;
  (window as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

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
});

afterEach(() => {
  cleanup();
  vi.mocked(audio.play).mockClear();
  vi.mocked(audio.unlock).mockClear();
  vi.mocked(renderSnapshot).mockClear();
});

afterAll(() => {
  clock.mockRestore();
});

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

const aiming = () =>
  state("aiming", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 500, 350)]);

const resolving = (p1: Partial<PawnSnapshot> = {}) =>
  state("moving", [
    pawnAt("p0", 300, 350, {
      isLocal: true,
      launch: { direction: { x: 1, y: 0 }, power: 3 },
    }),
    pawnAt("p1", 500, 350, {
      launch: { direction: { x: -1, y: 0 }, power: 3 },
      ...p1,
    }),
  ]);

function mountArena(initial: GameStateSnapshot) {
  const view = render(
    <ArenaView snapshot={initial} interactive onAim={() => {}} />
  );
  return {
    canvas: view.container.querySelector("canvas")!,
    feed(next: GameStateSnapshot) {
      view.rerender(<ArenaView snapshot={next} interactive onAim={() => {}} />);
    },
  };
}

describe("arena audio wiring", () => {
  it("the aiming → moving push sends round-start + launch events to audio", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    const batch = plays()[0]?.[0];
    expect(batch).toBeDefined();
    expect(batch.map((e) => e.type).sort()).toEqual(["launch", "launch", "round-start"]);
  });

  it("duplicate pushes never replay sounds", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    expect(plays()).toHaveLength(1);
    at(1116);
    arena.feed(resolving()); // same content re-pushed
    expect(plays()).toHaveLength(1);
  });

  it("an elimination push reaches audio exactly once", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    at(1200);
    arena.feed(resolving({ position: { x: 620, y: 350 }, eliminated: true }));
    expect(plays()[1]?.[0].map((e) => e.type)).toEqual(["elimination"]);
    at(1216);
    arena.feed(resolving({ position: { x: 625, y: 350 }, eliminated: true }));
    expect(plays()).toHaveLength(2);
  });

  it("the finished verdict reaches audio once, draws stay silent", () => {
    at(1000);
    const arena = mountArena(aiming());
    at(1100);
    arena.feed(resolving());
    at(1200);
    arena.feed(
      state("finished", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 620, 350)], {
        winnerId: "p1",
      })
    );
    expect(plays()[1]?.[0].map((e) => e.type)).toEqual(["winner"]);
    at(1216);
    arena.feed(
      state("finished", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 620, 350)], {
        winnerId: "p1",
      })
    );
    expect(plays()).toHaveLength(2); // no replay on the finished re-push
  });

  it("a pointer press on the arena unlocks audio; mere motion does not", () => {
    at(1000);
    const arena = mountArena(aiming());
    fireEvent.pointerDown(arena.canvas, { clientX: 400, clientY: 300 });
    expect(unlocks()).toHaveLength(1);
    fireEvent.pointerMove(arena.canvas, { clientX: 420, clientY: 310 });
    fireEvent.pointerMove(arena.canvas, { clientX: 440, clientY: 320 });
    expect(unlocks()).toHaveLength(1); // only real presses are gestures
  });
});
