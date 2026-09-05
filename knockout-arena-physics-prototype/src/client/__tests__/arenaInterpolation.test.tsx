// @vitest-environment jsdom
import "./lobbyTestHarness"; // ResizeObserver stub (jsdom ships none)
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ArenaView } from "../components/game/ArenaView";
import { render as renderSnapshot } from "../renderer";
import type { GamePhase, GameStateSnapshot, PawnSnapshot } from "../../game";

/**
 * The arena's RENDER-ONLY snapshot interpolation, wired end-to-end at the
 * component level (labels refer to the Task 17 spec):
 *
 *   10   a remote pawn renders BETWEEN two authoritative positions
 *   6    the local pawn keeps its authoritative position — no added delay
 *   5    state boundaries: aiming → moving resets (no smear across the
 *        boundary), moving → aiming, finished draws authoritative finals,
 *        an eliminated pawn is never interpolated across its knockout
 *   8/9  jitter tolerance: a starved timeline snaps to the newest state
 *        (no freeze, no extrapolation); a duplicate push and a late
 *        arrival never move the timeline backwards or teleport a pawn
 *   11   everything but remote positions (aim indicator, power) comes
 *        from the newest snapshot — aiming has NO interpolation lag
 *   12   the animation loop repaints BETWEEN pushes without React state
 *
 * The renderer is module-mocked to capture exactly what would be painted;
 * the rAF loop is a manual queue so each test drives frames explicitly,
 * and performance.now() is pinned to a scripted clock — no real time, no
 * flakiness. No server, no sockets: snapshots arrive as props.
 */

// Capture every render() call the arena makes (keep the real transform
// math — identical to the aiming suite's mock).
vi.mock("../renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer")>();
  return { ...actual, render: vi.fn(() => {}) };
});

/** The last snapshot the arena drew (via the mocked renderer). */
function lastDrawn(): GameStateSnapshot {
  const calls = vi.mocked(renderSnapshot).mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("the arena never drew");
  return last[1] as GameStateSnapshot;
}

function drawnPawn(id: string): PawnSnapshot {
  const pawn = lastDrawn().pawns.find((p) => p.id === id);
  if (pawn === undefined) throw new Error(`pawn ${id} not drawn`);
  return pawn;
}

function drawCount(): number {
  return vi.mocked(renderSnapshot).mock.calls.length;
}

// --- The scripted clock (performance.now is the interpolation clock). ---
let clockNow = 0;
const clock = vi.spyOn(performance, "now").mockImplementation(() => clockNow);
const at = (t: number) => {
  clockNow = t;
};

// --- The manual rAF queue (jsdom ships no requestAnimationFrame). ---
type FrameCallback = (time: number) => void;
let frames: FrameCallback[] = [];

function runOneFrame(): void {
  const cb = frames.shift();
  if (cb === undefined) throw new Error("no animation frame is pending");
  cb(clockNow); // re-registers itself inside the component's loop
}

beforeAll(() => {
  (window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
    (cb: FrameCallback) => {
      frames.push(cb);
      return frames.length;
    };
  (window as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame =
    () => {};

  // jsdom has no 2D context; the arena only needs a non-null one to reach
  // its (mocked) draw call.
  const fakeContext = { setTransform: () => {} } as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() =>
    fakeContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // "Measure" the canvas at a fixed size so the draw path is live.
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
    get: () => 800,
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
    get: () => 600,
    configurable: true,
  });
});

beforeEach(() => {
  at(0);
});

afterEach(() => {
  cleanup(); // no vitest globals → manual RTL cleanup
  frames = [];
  vi.mocked(renderSnapshot).mockClear();
});

afterAll(() => {
  clock.mockRestore();
});

// --- Snapshot builders (typed, minimal, local-perspective). ---
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

/** A resolving round: local p0 (witness) + remote p1. */
function round(
  local: { x: number; y: number },
  remote: { x: number; y: number },
  remoteExtra: Partial<PawnSnapshot> = {}
): GameStateSnapshot {
  return state("moving", [
    pawnAt("p0", local.x, local.y, { isLocal: true }),
    pawnAt("p1", remote.x, remote.y, remoteExtra),
  ]);
}

/** Render the arena directly and return a prop-driven snapshot feed. */
function mountArena(initial: GameStateSnapshot) {
  const props = { interactive: false, onAim: () => {} };
  const view = render(<ArenaView snapshot={initial} {...props} />);
  return {
    feed(next: GameStateSnapshot) {
      view.rerender(<ArenaView snapshot={next} {...props} />);
    },
  };
}

describe("arena render interpolation", () => {
  it("renders a remote pawn between two authoritative pushes (10)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    // t=1100: the newest push says p1 has reached (100, 0) — but the
    // render clock lags by the interpolation delay (t=1050), so the pawn
    // is drawn HALFWAY: smooth, and never ahead of the authority.
    at(1100);
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 50, y: 0 });
  });

  it("the local pawn keeps its newest authoritative position (6)", () => {
    at(1000);
    const arena = mountArena(round({ x: 0, y: 0 }, { x: 0, y: 0 }));
    at(1100);
    // Both pawns moved; the remote one interpolates (halfway), the local
    // one is drawn exactly where the newest push says it is.
    arena.feed(round({ x: 100, y: 100 }, { x: 100, y: 0 }));
    expect(drawnPawn("p0").position).toEqual({ x: 100, y: 100 });
    expect(drawnPawn("p1").position).toEqual({ x: 50, y: 0 });
  });

  it("the animation loop repaints between pushes (12)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    at(1100);
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 50, y: 0 });
    const before = drawCount();
    // A frame arrives with NO new snapshot behind it: the loop advances
    // the interpolation clock on its own (t=1120 → render time 1070).
    at(1120);
    runOneFrame();
    expect(drawCount()).toBeGreaterThan(before);
    expect(drawnPawn("p1").position).toEqual({ x: 70, y: 0 });
  });

  it("aiming snapshots draw instantly — no interpolation lag (11)", () => {
    at(1000);
    const arena = mountArena(
      state("aiming", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 0, 0)])
    );
    at(1100);
    // New aim echo + power arrive; the drawn picture must be exactly the
    // newest snapshot — the aim indicator never lags behind the mouse.
    const aiming = state(
      "aiming",
      [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 10, 0)],
      { aimDirection: { x: 0, y: 1 }, power: 5, isAiming: true }
    );
    arena.feed(aiming);
    const drawn = lastDrawn();
    expect(drawn).toBe(aiming); // the authoritative object itself
    expect(drawn.aimDirection).toEqual({ x: 0, y: 1 });
    expect(drawn.power).toBe(5);
    expect(drawnPawn("p1").position).toEqual({ x: 10, y: 0 });
  });

  it("aiming → moving resets the buffer: no smear across the boundary (5)", () => {
    at(1000);
    const arena = mountArena(
      state("aiming", [pawnAt("p0", 300, 350, { isLocal: true }), pawnAt("p1", 0, 0)])
    );
    at(1100);
    // The round resolves: p1 jumps to (40,0) in the first moving push.
    // Without the phase-change reset, the render time (1050) would land
    // between the last aiming push and this one and smear to (20,0).
    arena.feed(round({ x: 300, y: 350 }, { x: 40, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 40, y: 0 });
  });

  it("interpolation resumes within the resolving round (5)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 40, y: 0 }));
    at(1200);
    // p1 continued from (40,0) to (140,0) between t=1000 and t=1200; the
    // render time (1150) is 3/4 along that span → (115, 0).
    arena.feed(round({ x: 300, y: 350 }, { x: 140, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 115, y: 0 });
  });

  it("finished draws the authoritative final positions (5)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    at(1100);
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 })); // mid-flight
    at(1200);
    // Match over: the final frame must be exactly the server's verdict —
    // the buffer history from the resolving round must not leak in.
    const finished = state(
      "finished",
      [pawnAt("p0", 300, 350, { isLocal: true, eliminated: true }), pawnAt("p1", 250, 0)],
      { winnerId: "p1" }
    );
    arena.feed(finished);
    const drawn = lastDrawn();
    expect(drawn).toBe(finished);
    expect(drawn.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 250, y: 0 });
    expect(drawn.winnerId).toBe("p1");
  });

  it("an eliminated pawn is never interpolated across its knockout (5)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    at(1100);
    // p1 is knocked out at (100,0): drawn exactly there, not halfway.
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }, { eliminated: true }));
    const p1 = drawnPawn("p1");
    expect(p1.eliminated).toBe(true);
    expect(p1.position).toEqual({ x: 100, y: 0 });
  });

  it("a starved timeline snaps to the newest state — no freeze, no extrapolation (8)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    at(1100);
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 50, y: 0 });
    // No snapshot for 200 ms: the render time runs past the buffer; the
    // newest authoritative position is drawn — never a stale midpoint,
    // never a made-up position beyond it.
    at(1300);
    runOneFrame();
    expect(drawnPawn("p1").position).toEqual({ x: 100, y: 0 });
  });

  it("a duplicate push never teleports a pawn (9)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    at(1100);
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 50, y: 0 });
    // The same state is delivered again at the same instant: dropped by
    // the buffer (no timeline corruption) and invisible in the drawing —
    // when the render time catches up with the newest arrival, the pawn
    // sits exactly at the authoritative position.
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }));
    at(1150);
    runOneFrame();
    expect(drawnPawn("p1").position).toEqual({ x: 100, y: 0 });
  });

  it("a late arrival never moves the timeline backwards (9)", () => {
    at(1000);
    const arena = mountArena(round({ x: 300, y: 350 }, { x: 0, y: 0 }));
    at(1100);
    arena.feed(round({ x: 300, y: 350 }, { x: 100, y: 0 }));
    // A push stamped BEFORE the newest buffered arrival is ignored by the
    // buffer; the remote timeline keeps interpolating the buffered pair
    // (render time 1000 → exactly the older endpoint), while the newest
    // STATE still becomes the source of truth for everything else.
    at(1050);
    arena.feed(round({ x: 300, y: 350 }, { x: 500, y: 0 }));
    expect(drawnPawn("p1").position).toEqual({ x: 0, y: 0 });
    // Once the render clock catches up past the buffered arrivals, the
    // newest authoritative state draws.
    at(1200);
    runOneFrame();
    expect(drawnPawn("p1").position).toEqual({ x: 500, y: 0 });
  });
});
