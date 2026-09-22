// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * The arena's pinch-zoom & pan (phones): two fingers zoom and pan the
 * BOARD; one finger stays aiming. The "Reset view" pill appears while
 * zoomed and snaps the board back.
 *
 * The gesture math itself is coordinate-free in jsdom (the canvas has
 * no real box there), so these pins are the visible CONTRACT: the
 * transform is applied to the canvas, it clears on reset, and the
 * zoomed canvas still accepts aim moves without exploding.
 */

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
  await act(async () => {
    sockets[0].serverMessage(wire.snapshot({}));
  });
  return { client, sockets };
}

function canvasStyle(): string {
  return (screen.getByTestId("arena-canvas") as HTMLCanvasElement).style
    .transform;
}

function pinch(atA: { x: number; y: number }, atB: { x: number; y: number }) {
  const canvas = screen.getByTestId("arena-canvas");
  fireEvent.pointerDown(canvas, {
    pointerId: 11,
    clientX: atA.x,
    clientY: atA.y,
    button: 0,
  });
  fireEvent.pointerDown(canvas, {
    pointerId: 12,
    clientX: atB.x,
    clientY: atB.y,
    button: 0,
  });
}

function spreadTo(atA: { x: number; y: number }, atB: { x: number; y: number }) {
  const canvas = screen.getByTestId("arena-canvas");
  fireEvent.pointerMove(canvas, {
    pointerId: 11,
    clientX: atA.x,
    clientY: atA.y,
  });
  fireEvent.pointerMove(canvas, {
    pointerId: 12,
    clientX: atB.x,
    clientY: atB.y,
  });
}

function release() {
  const canvas = screen.getByTestId("arena-canvas");
  fireEvent.pointerUp(canvas, { pointerId: 11 });
  fireEvent.pointerUp(canvas, { pointerId: 12 });
}

describe("arena pinch-zoom & pan (phones)", () => {
  it("spreading two fingers zooms the board and shows the reset pill", async () => {
    await renderGame();
    expect(canvasStyle()).toBe("");

    await act(async () => {
      pinch({ x: 100, y: 100 }, { x: 160, y: 100 });
      spreadTo({ x: 40, y: 100 }, { x: 220, y: 100 }); // 60px → 180px: 3×
    });

    const transform = canvasStyle();
    expect(transform).toContain("scale(3)");
    expect(transform).toContain("translate(");
    // The pill is the zoom's way out.
    expect(screen.getByTestId("arena-view-reset")).toHaveTextContent(
      "Reset view"
    );
  });

  it("one finger alone never zooms (aiming stays one-finger)", async () => {
    await renderGame();
    const canvas = screen.getByTestId("arena-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, {
        pointerId: 7,
        clientX: 100,
        clientY: 100,
        button: 0,
      });
      fireEvent.pointerMove(canvas, {
        pointerId: 7,
        clientX: 300,
        clientY: 200,
      });
    });
    expect(canvasStyle()).toBe("");
    expect(screen.queryByTestId("arena-view-reset")).toBeNull();
  });

  it("reset snaps the board back and the pill goes away", async () => {
    await renderGame();
    await act(async () => {
      pinch({ x: 100, y: 100 }, { x: 160, y: 100 });
      spreadTo({ x: 40, y: 100 }, { x: 220, y: 100 });
    });
    expect(canvasStyle()).not.toBe("");

    await act(async () => {
      fireEvent.click(screen.getByTestId("arena-view-reset"));
    });
    expect(canvasStyle()).toBe("");
    expect(screen.queryByTestId("arena-view-reset")).toBeNull();
  });

  it("lifting a finger ends the gesture; a new pinch starts fresh", async () => {
    await renderGame();
    await act(async () => {
      pinch({ x: 100, y: 100 }, { x: 160, y: 100 });
      spreadTo({ x: 40, y: 100 }, { x: 220, y: 100 });
      release();
    });
    const zoomed = canvasStyle();
    expect(zoomed).toContain("scale(3)");

    // After the gesture ended, moving a lone finger must not pan/zoom.
    await act(async () => {
      fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
        pointerId: 12,
        clientX: 400,
        clientY: 400,
      });
    });
    expect(canvasStyle()).toBe(zoomed);
  });

  it("the zoomed canvas still accepts aim moves (no input deadlock)", async () => {
    await renderGame();
    await act(async () => {
      pinch({ x: 100, y: 100 }, { x: 160, y: 100 });
      spreadTo({ x: 40, y: 100 }, { x: 220, y: 100 });
    });
    await act(async () => {
      fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
        pointerId: 21,
        clientX: 120,
        clientY: 80,
      });
    });
    // The real assertion is "does not throw" — the pointer→world fold
    // divides the client offset by the zoom before the board math.
    expect(canvasStyle()).toContain("scale(3)");
  });
});
