// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { render as renderSnapshot } from "../renderer";
import type { GameStateSnapshot } from "../../game";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * Click-to-lock aiming: the arrow follows the mouse while unlocked, but a
 * PRIMARY-button click on the arena selects the current direction and
 * LOCKS it — later mouse movement no longer re-aims, so the trip towards
 * the Confirm button cannot disturb the choice.
 *
 * What these tests pin (scripted sockets — the pure client↔UI loop):
 *
 *  1. mouse movement changes the aim while unlocked;
 *  2. a primary arena click selects the current direction (and locks it);
 *  3. mouse movement after locking does NOT change the direction;
 *  4. clicking Confirm uses the locked direction and never changes it;
 *  5. a new aiming round resets the lock;
 *  6. UI clicks (power, Confirm, the control bar) never parade as aims;
 *  7. clicking the arena again selects and locks a new direction.
 *
 * The lock is input gating only: server-authoritative aim handling is
 * unchanged — every selection is still a normal aim intent, the server's
 * echo still wins, and Confirm still sends only confirmLaunch.
 *
 * (Harness notes: the canvas is "measured" with fixed element-level
 * sizes so the real coordinate transform runs — identity here, 900×700
 * with a (50, 60) page offset — and the renderer's draw call is captured
 * through a module mock. The local pawn sits at world (300, 350).)
 */

// Capture every render() call the arena makes (keep the real transform
// math — the input path depends on it).
vi.mock("../renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer")>();
  return { ...actual, render: vi.fn(() => {}) };
});

beforeAll(() => {
  // jsdom has no 2D context; the arena only needs a non-null one to
  // reach its (mocked) draw call.
  const fakeContext = { setTransform: () => {} } as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() =>
    fakeContext) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup(); // no vitest globals → manual RTL cleanup
  vi.mocked(renderSnapshot).mockClear();
  restoreCanvasMeasurement();
});

/** Render the game screen directly (same wiring as the real Lobby). */
async function renderGame() {
  const { client, sockets } = createScriptedClient();
  render(
    <NetworkProvider client={client}>
      <MultiplayerGame onLeave={() => client.leaveRoom()} />
    </NetworkProvider>
  );
  await act(async () => {
    client.connect();
  });
  await act(async () => {
    sockets[0].serverOpen();
  });
  return { client, sockets };
}

/** Send one snapshot (act-wrapped) and return its parsed state. */
async function feed(
  sockets: ReturnType<typeof createScriptedClient>["sockets"],
  overrides: Record<string, unknown> = {},
  pawnOverrides: Record<string, Record<string, unknown>> = {}
): Promise<GameStateSnapshot> {
  const raw = wire.snapshot(overrides, pawnOverrides);
  await act(async () => {
    sockets[0].serverMessage(raw);
  });
  return JSON.parse(raw).state as GameStateSnapshot;
}

/** The commands the client put on the wire, parsed. */
const sentCommands = (sockets: ReturnType<typeof createScriptedClient>["sockets"]) =>
  sockets[0].sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "command")
    .map((message) => message.command);

/** The last snapshot the arena drew (via the mocked renderer). */
function lastDrawn(): GameStateSnapshot {
  const calls = vi.mocked(renderSnapshot).mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("the arena never drew");
  return last[1] as GameStateSnapshot;
}

/**
 * "Measure" every canvas: shadow the element-level clientWidth/Height and
 * getBoundingClientRect with fixed values. Call BEFORE the first snapshot;
 * restoreCanvasMeasurement() undoes it.
 */
function measureCanvas(
  width: number,
  height: number,
  rectLeft = 0,
  rectTop = 0
): void {
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
    get: () => width,
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
    get: () => height,
    configurable: true,
  });
  HTMLCanvasElement.prototype.getBoundingClientRect = function (this: HTMLCanvasElement) {
    return {
      x: rectLeft,
      y: rectTop,
      left: rectLeft,
      top: rectTop,
      right: rectLeft + width,
      bottom: rectTop + height,
      width,
      height,
      toJSON: () => "",
    } as DOMRect;
  };
}

function restoreCanvasMeasurement(): void {
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)
    .clientWidth;
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)
    .clientHeight;
  delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)
    .getBoundingClientRect;
}

const canvasEl = () => screen.getByTestId("arena-canvas");

/** World (750, 350): dead right of the local pawn → direction (1, 0). */
const RIGHT = { clientX: 50 + 750, clientY: 60 + 350 };
/** World (150, 350): dead left of the local pawn → direction (-1, 0). */
const LEFT = { clientX: 50 + 150, clientY: 60 + 350 };

describe("aim lock (1): mouse movement changes the aim while unlocked", () => {
  it("moves aim freely before any click", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), RIGHT);
    expect(sentCommands(sockets)).toEqual([{ type: "aim", x: 750, y: 350 }]);
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    fireEvent.pointerMove(canvasEl(), LEFT);
    expect(sentCommands(sockets)).toEqual([
      { type: "aim", x: 750, y: 350 },
      { type: "aim", x: 150, y: 350 },
    ]);
    expect(lastDrawn().aimDirection).toEqual({ x: -1, y: 0 });
  });
});

describe("aim lock (2, 3): a primary click selects the direction and locks it", () => {
  it("the click sends the current direction; later moves send nothing and the arrow stays", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), RIGHT);
    // A primary click on the arena selects the direction under the cursor…
    fireEvent.pointerDown(canvasEl(), { button: 0, ...RIGHT });
    expect(sentCommands(sockets)).toEqual([
      { type: "aim", x: 750, y: 350 },
      { type: "aim", x: 750, y: 350 },
    ]);
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    // …and LOCKS it: wandering towards Confirm changes nothing.
    fireEvent.pointerMove(canvasEl(), LEFT);
    fireEvent.pointerMove(canvasEl(), { clientX: 50 + 750, clientY: 60 + 100 });
    expect(sentCommands(sockets)).toHaveLength(2); // nothing new
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });
    expect(lastDrawn().isAiming).toBe(true);
  });
});

describe("aim lock (4): Confirm uses the locked direction and never changes it", () => {
  it("Confirm sends only confirmLaunch; the locked arrow survives through the confirmation", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), RIGHT);
    fireEvent.pointerDown(canvasEl(), { button: 0, ...RIGHT });

    fireEvent.click(screen.getByTestId("launch"));
    // Only the confirm intent left the client after the lock — no aim,
    // no movement, nothing else. The round will use the server's stored
    // (locked) aim when it resolves.
    expect(sentCommands(sockets)).toEqual([
      { type: "aim", x: 750, y: 350 },
      { type: "aim", x: 750, y: 350 },
      { type: "confirmLaunch" },
    ]);
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    // Even before the server's echo, the mouse cannot disturb the choice.
    fireEvent.pointerMove(canvasEl(), LEFT);
    expect(sentCommands(sockets)).toHaveLength(3);
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    // The authoritative confirmation keeps the locked direction — drawn
    // from the server's own data, not a local guess.
    await feed(
      sockets,
      { aimDirection: { x: 1, y: 0 }, isAiming: true },
      { p0: { confirmed: true } }
    );
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });
    expect(screen.getByTestId("launch")).toBeDisabled();
    expect(screen.getByTestId("launch")).toHaveTextContent(
      "Confirmed — waiting…"
    );
  });
});

describe("aim lock (5): a new aiming round resets the lock", () => {
  it("the round resolving unlocks; the fresh round aims freely again", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), RIGHT);
    fireEvent.pointerDown(canvasEl(), { button: 0, ...RIGHT });
    fireEvent.pointerMove(canvasEl(), LEFT);
    expect(sentCommands(sockets)).toHaveLength(2); // the lock is engaged

    // The round resolves (e.g. at the server's deadline)…
    await feed(sockets, { phase: "moving", aimDirection: null, isAiming: false });
    // …and a fresh aiming round opens: the lock is gone.
    await feed(sockets, { phase: "aiming", aimDirection: null, isAiming: false });

    fireEvent.pointerMove(canvasEl(), LEFT);
    expect(sentCommands(sockets)).toHaveLength(3);
    expect(sentCommands(sockets)[2]).toEqual({ type: "aim", x: 150, y: 350 });
    expect(lastDrawn().aimDirection).toEqual({ x: -1, y: 0 });
  });
});

describe("aim lock (6): UI clicks are never treated as aiming clicks", () => {
  it("power, Confirm and control-bar presses send no aim and move no arrow", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, { aimDirection: { x: 1, y: 0 }, isAiming: true });

    fireEvent.click(screen.getByRole("button", { name: "Power 4" }));
    fireEvent.click(screen.getByTestId("launch"));
    fireEvent.pointerDown(screen.getByTestId("match-controls"), {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    // Intents only — not a single aim among them.
    expect(sentCommands(sockets)).toEqual([
      { type: "setPower", power: 4 },
      { type: "confirmLaunch" },
    ]);
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    // Positive control: the canvas itself still aims (input is alive —
    // UI clicks merely bypass it).
    fireEvent.pointerMove(canvasEl(), LEFT);
    expect(sentCommands(sockets)).toHaveLength(3);
    expect(sentCommands(sockets)[2]).toEqual({ type: "aim", x: 150, y: 350 });
  });
});

describe("aim lock (7): clicking the arena again selects a new direction", () => {
  it("a second click re-aims and stays locked; the choice is still open", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), RIGHT);
    fireEvent.pointerDown(canvasEl(), { button: 0, ...RIGHT });
    fireEvent.pointerMove(canvasEl(), LEFT);
    expect(sentCommands(sockets)).toHaveLength(2); // locked

    // Clicking the arena again selects AND locks the new direction.
    fireEvent.pointerDown(canvasEl(), { button: 0, ...LEFT });
    expect(sentCommands(sockets)).toHaveLength(3);
    expect(sentCommands(sockets)[2]).toEqual({ type: "aim", x: 150, y: 350 });
    expect(lastDrawn().aimDirection).toEqual({ x: -1, y: 0 });

    // Still locked — and still unconfirmed, so Confirm stays available.
    fireEvent.pointerMove(canvasEl(), RIGHT);
    expect(sentCommands(sockets)).toHaveLength(3);
    expect(lastDrawn().aimDirection).toEqual({ x: -1, y: 0 });
    expect(screen.getByTestId("launch")).toBeEnabled();
  });
});
