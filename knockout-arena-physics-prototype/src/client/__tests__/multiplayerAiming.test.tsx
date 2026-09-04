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
 * The multiplayer AIMING interaction over scripted sockets — the pure
 * client↔UI loop (labels refer to the Task 13 spec):
 *
 *  1   mouse position → world coordinates → aim command (identity,
 *      scaled/centered, and device-pixel-ratio ≠ 1)
 *  2   moving the mouse changes the previewed direction; the optimistic
 *      preview follows instantly and the server's echo takes over
 *  3   left AND right mouse buttons both aim
 *  4   the context menu is suppressed ON THE ARENA only — never globally
 *  5   (arrow length ∝ power is pinned in rendererAim.test.ts; here: the
 *      power choice reaches the drawn snapshot immediately)
 *  6   the direction stays changeable until the player confirms
 *  7/8  confirming locks the controls; the confirm itself sends only the
 *      confirmLaunch command (never a movement)
 *  19  the power control offers exactly the integers 1–5
 *  21  the power control is disabled after confirmation
 *
 * The canvas is "measured" by overriding the element's client size and
 * bounding rect, so the real coordinate transform runs; the renderer's
 * draw call is captured through a module mock (the pure geometry itself
 * is tested in rendererAim.test.ts against a recording context).
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
 * getBoundingClientRect with fixed values, so the arena's real measuring
 * (ResizeObserver-based, runs when the game state first appears) sees a
 * concrete size and the real coordinate transform becomes observable.
 * Call BEFORE the first snapshot; restoreCanvasMeasurement() undoes it.
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

describe("multiplayer aiming — mouse to world (1)", () => {
  it("an identity canvas maps client → world 1:1 (with page offset)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60); // world-sized canvas, offset on the page
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), { clientX: 50 + 750, clientY: 60 + 350 });
    expect(sentCommands(sockets)).toEqual([
      { type: "aim", x: 750, y: 350 },
    ]);
  });

  it("a smaller, scaled + centered canvas divides by the transform scale", async () => {
    const { sockets } = await renderGame();
    // 450×350 canvas: scale = min(450/900, 350/700) = 0.5, offsets 0 —
    // the world is drawn at half size, centered.
    measureCanvas(450, 350);
    await feed(sockets, {});

    fireEvent.pointerMove(canvasEl(), { clientX: 300, clientY: 175 });
    expect(sentCommands(sockets)).toEqual([
      { type: "aim", x: 600, y: 350 }, // 300/0.5, 175/0.5
    ]);
  });

  it("a device pixel ratio ≠ 1 changes nothing (CSS pixels, not device pixels)", async () => {
    const { client, sockets } = await renderGame();
    const original =
      Object.getOwnPropertyDescriptor(window, "devicePixelRatio") ??
      { value: 1, configurable: true };
    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });
    try {
      measureCanvas(900, 700, 50, 60);
      await feed(sockets, {});
      fireEvent.pointerMove(canvasEl(), { clientX: 800, clientY: 410 });
      expect(sentCommands(sockets)).toEqual([{ type: "aim", x: 750, y: 350 }]);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", original);
      client.getState(); // touch — keeps the linter honest about usage
    }
  });
});

describe("multiplayer aiming — mouse buttons and context menu (3, 4)", () => {
  it("left click selects the direction under the cursor", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerDown(canvasEl(), { button: 0, clientX: 50 + 750, clientY: 60 + 350 });
    expect(sentCommands(sockets)).toEqual([{ type: "aim", x: 750, y: 350 }]);
  });

  it("right click selects the direction too (it is an aim, not a menu)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    fireEvent.pointerDown(canvasEl(), { button: 2, clientX: 50 + 150, clientY: 60 + 350 });
    expect(sentCommands(sockets)).toEqual([{ type: "aim", x: 150, y: 350 }]);
  });

  it("the context menu is suppressed ON THE ARENA — and nowhere else", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});

    // On the arena canvas: prevented (right-click aiming owns the button).
    expect(fireEvent.contextMenu(canvasEl())).toBe(false);
    // Anywhere else on the page: the browser's normal behavior stands
    // (no global contextmenu suppression was installed).
    expect(fireEvent.contextMenu(document.body)).toBe(true);
    // And no command left the client over a context menu.
    expect(sentCommands(sockets)).toHaveLength(0);
  });
});

describe("multiplayer aiming — the live preview (2)", () => {
  it("the arrow follows the mouse INSTANTLY (before any server echo)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});
    vi.mocked(renderSnapshot).mockClear();

    // The local pawn (harness default) sits at (300, 350). A cursor at
    // world (750, 350) is dead right of it: preview (1, 0).
    fireEvent.pointerMove(canvasEl(), { clientX: 50 + 750, clientY: 60 + 350 });
    let drawn = lastDrawn();
    expect(drawn.aimDirection).toEqual({ x: 1, y: 0 });
    expect(drawn.isAiming).toBe(true); // an arrow is drawn for it

    // Move the cursor dead left of the pawn: the preview flips at once.
    fireEvent.pointerMove(canvasEl(), { clientX: 50 + 150, clientY: 60 + 350 });
    drawn = lastDrawn();
    expect(drawn.aimDirection).toEqual({ x: -1, y: 0 });

    // Both moves also shipped the real aim commands (server authority).
    expect(sentCommands(sockets)).toEqual([
      { type: "aim", x: 750, y: 350 },
      { type: "aim", x: 150, y: 350 },
    ]);
  });

  it("the server's echo takes over once it catches up (the preview never wins)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});
    fireEvent.pointerMove(canvasEl(), { clientX: 50 + 750, clientY: 60 + 350 });
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    // An echo for an OLDER aim still arrives: the fresh preview stays.
    await feed(sockets, { aimDirection: { x: 0, y: -1 }, isAiming: true });
    expect(lastDrawn().aimDirection).toEqual({ x: 1, y: 0 });

    // The echo of the CURRENT aim catches up: the preview is dropped and
    // the authoritative value draws.
    await feed(sockets, { aimDirection: { x: 1, y: 0 }, isAiming: true });
    // …and the NEXT snapshot (any change) draws straight from the server.
    await feed(sockets, { aimDirection: { x: 0, y: 1 }, isAiming: true });
    expect(lastDrawn().aimDirection).toEqual({ x: 0, y: 1 });
  });

  it("a cursor on the pawn's own center changes nothing (the aim stays)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700);
    await feed(sockets, {});
    // The local pawn sits at (300, 350) — a cursor exactly there yields
    // no direction (and the server would ignore that aim too).
    fireEvent.pointerMove(canvasEl(), { clientX: 300, clientY: 350 });
    expect(sentCommands(sockets)).toEqual([{ type: "aim", x: 300, y: 350 }]);
    const drawn = lastDrawn();
    expect(drawn.aimDirection).toEqual({ x: 1, y: 0 }); // the harness default
    expect(drawn.isAiming).toBe(false); // no preview invented over it
  });
});

describe("multiplayer aiming — changing the choice (6, 7, 8)", () => {
  it("the direction stays freely changeable until the player confirms", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700, 50, 60);
    await feed(sockets, {});

    // Select a direction…
    fireEvent.pointerDown(canvasEl(), { button: 0, clientX: 50 + 750, clientY: 60 + 350 });
    // …the echo of that selection arrives…
    await feed(sockets, { aimDirection: { x: 1, y: 0 }, isAiming: true });
    // …and moving again STILL changes the direction (nothing is locked
    // by the first click — only Confirm locks).
    fireEvent.pointerMove(canvasEl(), { clientX: 50 + 750, clientY: 60 + 100 });
    expect(sentCommands(sockets)).toHaveLength(2);
    expect(sentCommands(sockets)[1]).toEqual({ type: "aim", x: 750, y: 100 });
    expect(screen.getByTestId("launch")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Power 4" })).toBeEnabled();
  });

  it("confirming locks aim + power: controls off, one confirmLaunch, no movement (7, 8)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700);
    await feed(sockets, { aimDirection: { x: 0, y: 1 }, isAiming: true });
    vi.mocked(renderSnapshot).mockClear();

    fireEvent.click(screen.getByTestId("launch"));
    // Only the confirm intent left the client — no movement, no timeout,
    // nothing else. The pawn moves when the SERVER resolves the round.
    expect(sentCommands(sockets)).toEqual([{ type: "confirmLaunch" }]);

    // The authoritative confirmation echo: everything locks (the locked
    // aim stays in the snapshot — the server keeps it for the round).
    await feed(
      sockets,
      { aimDirection: { x: 0, y: 1 }, isAiming: true },
      { p0: { confirmed: true } }
    );
    expect(screen.getByTestId("launch")).toBeDisabled();
    expect(screen.getByTestId("launch")).toHaveTextContent(
      "Confirmed — waiting…"
    );
    for (const level of [1, 2, 3, 4, 5]) {
      expect(
        screen.getByRole("button", { name: `Power ${level}` })
      ).toBeDisabled();
    }
    // The locked arrow remains visible — as the server's own data, not a
    // local guess: the drawn snapshot is exactly the authoritative one.
    const drawn = lastDrawn();
    expect(drawn.aimDirection).toEqual({ x: 0, y: 1 });
    expect(drawn.pawns.find((p) => p.id === "p0")!.confirmed).toBe(true);
    // And further mouse input is refused while locked.
    fireEvent.pointerMove(canvasEl(), { clientX: 900, clientY: 500 });
    expect(sentCommands(sockets)).toHaveLength(1); // nothing new
  });

  it("OTHER players' confirmations never lock the local input (simultaneous rounds)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p1: { confirmed: true } });
    expect(screen.getByTestId("launch")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Power 3" })).toBeEnabled();
    // The rail shows the other player's readiness — no direction of
    // theirs exists anywhere to show.
    expect(screen.getByTestId("rail-p1").textContent).toContain("Ready");
  });
});

describe("multiplayer aiming — the power control (19, 21, 5)", () => {
  it("offers exactly the five integer levels and sends each as setPower", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});
    const buttons = screen.getAllByRole("button", { name: /^Power [1-5]$/ });
    expect(buttons).toHaveLength(5);

    for (const level of [1, 2, 3, 4, 5]) {
      fireEvent.click(screen.getByRole("button", { name: `Power ${level}` }));
    }
    expect(sentCommands(sockets)).toEqual([
      { type: "setPower", power: 1 },
      { type: "setPower", power: 2 },
      { type: "setPower", power: 3 },
      { type: "setPower", power: 4 },
      { type: "setPower", power: 5 },
    ]);
    // No fractional value exists to send: the readout shows the integer.
    expect(screen.getByTestId("power-readout")).toHaveTextContent("5");
  });

  it("a power choice reaches the drawn arrow immediately (before the echo)", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700);
    await feed(sockets, { aimDirection: { x: 1, y: 0 }, isAiming: true });
    vi.mocked(renderSnapshot).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Power 5" }));
    expect(lastDrawn().power).toBe(5); // the arrow's length input, at once
  });

  it("the meter is disabled once the local player has confirmed (21)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { confirmed: true } });
    for (const level of [1, 2, 3, 4, 5]) {
      expect(
        screen.getByRole("button", { name: `Power ${level}` })
      ).toBeDisabled();
    }
    expect(screen.getByTestId("power-meter")).toBeInTheDocument();
  });
});

describe("multiplayer aiming — the movement reveal reaches the arena (12, 13)", () => {
  it("the arena draws exactly the server's launch data during moving", async () => {
    const { sockets } = await renderGame();
    measureCanvas(900, 700);
    await feed(sockets, {});
    vi.mocked(renderSnapshot).mockClear();

    // The server resolves the round: one confirmed launch, one silent
    // player. The drawn snapshot carries exactly that — nothing more.
    await feed(
      sockets,
      { phase: "moving", aimDirection: null, isAiming: false },
      {
        p0: { launch: { direction: { x: 0, y: 1 }, power: 2 } },
        p1: { launch: null },
      }
    );
    const drawn = lastDrawn();
    expect(drawn.phase).toBe("moving");
    expect(drawn.pawns.find((p) => p.id === "p0")!.launch).toEqual({
      direction: { x: 0, y: 1 },
      power: 2,
    });
    expect(drawn.pawns.find((p) => p.id === "p1")!.launch).toBeNull();
    // The aiming controls are gone for the movement phase.
    expect(screen.getByTestId("launch")).toBeDisabled();
  });
});
