// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * THE MATCH CLOCKS' PLACE ON SCREEN.
 *
 * Requested: the "time left in the match" readout belongs BELOW the top
 * bar on the arena screen, not crammed into the header next to the logo.
 *
 * It lives in a dedicated CLOCK BAR above the arena — a real strip in
 * normal flow (not an overlay), centered on the arena column, with the
 * round decision countdown sitting right beside it. Things that have to
 * stay true, and are easy to break by accident:
 *
 *   - the bar is IN FLOW, so the clocks never cover the board (the
 *     arena canvas is a sibling BELOW the bar, not under it);
 *   - the clocks still belong to the arena column, never the header;
 *   - the shrink warning overlays the canvas on its own again (it no
 *     longer shares a band with the clocks, so it needs no clearance).
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
  return { client, sockets };
}

async function feed(
  sockets: ReturnType<typeof createScriptedClient>["sockets"],
  overrides: Record<string, unknown> = {}
) {
  await act(async () => {
    sockets[0].serverMessage(wire.snapshot(overrides));
  });
}

/** A live match deadline, comfortably in the future. */
const deadline = () => Date.now() + 120_000;

describe("the match clock sits below the top bar", () => {
  it("is no longer inside the header", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(timer).toBeInTheDocument();
    // The whole point of the move: the clock is outside the top bar.
    expect(header!.contains(timer)).toBe(false);
  });

  it("renders below the header in document order", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const header = document.querySelector("header")!;
    const timer = screen.getByTestId("match-timer");
    expect(header.compareDocumentPosition(timer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("lives in its own in-flow bar, never floating over the board", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const bar = timer.parentElement!;
    // A real strip above the arena — not an absolutely positioned
    // overlay — so the clocks can never cover the board.
    expect(bar).toHaveAttribute("data-testid", "clock-bar");
    expect(bar.className).not.toContain("absolute");
    // The canvas is NOT inside the bar: sibling below it, not under it.
    expect(bar.contains(screen.getByTestId("arena-canvas"))).toBe(false);
  });

  it("sits above the canvas as its sibling in the arena column", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const main = document.querySelector("main")!;
    const canvas = screen.getByTestId("arena-canvas");
    // Same arena column…
    expect(main.contains(timer)).toBe(true);
    expect(main.contains(canvas)).toBe(true);
    // …and the bar comes BEFORE the canvas in document order: the strip
    // is above the board, and the board keeps its full height.
    expect(
      timer.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("the shrink warning overlays the canvas on its own band again", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {
      matchDeadline: deadline(),
      arena: {
        centerX: 450,
        centerY: 350,
        radius: 330,
        wallThickness: 16,
        shrinkWarning: true,
        nextRadius: 290,
      },
    });

    const bar = screen.getByTestId("match-timer").parentElement!;
    const band = screen.getByTestId("shrink-warning").parentElement!;
    // The clocks' bar is in flow; the warning is the arena's only top
    // overlay now — so they structurally cannot collide anymore.
    expect(bar.className).not.toContain("absolute");
    expect(band.className).toContain("absolute");
  });

  it("no longer makes the shrink warning reserve room for the clocks", async () => {
    // The clocks moved out of the arena's overlay band into their own
    // bar, so the warning's top padding is back to a small value — the
    // old large clearance (pt-14, sized to clear a clock badge) would
    // now just push the warning oddly far down the board.
    const { sockets } = await renderGame();
    await feed(sockets, {
      matchDeadline: deadline(),
      roundDeadline: Date.now() + 5_000,
      arena: {
        centerX: 450,
        centerY: 350,
        radius: 330,
        wallThickness: 16,
        shrinkWarning: true,
        nextRadius: 290,
      },
    });

    const band = screen.getByTestId("shrink-warning").parentElement!;
    const topPad = (cls: string): number => {
      const token = cls.split(" ").find((c) => c.startsWith("pt-"));
      return token === undefined ? 0 : Number(token.slice(3));
    };
    expect(topPad(band.className)).toBeLessThanOrEqual(2);
  });

  it("the decision countdown sits beside the clock, over the arena", async () => {
    // Requested: the decision-time badge lives NEXT TO the match clock —
    // one centered row over the arena — not in the top-right header.
    const { sockets } = await renderGame();
    await feed(sockets, {
      matchDeadline: deadline(),
      roundDeadline: Date.now() + 5_000,
    });

    const clock = screen.getByTestId("match-timer");
    const countdown = screen.getByTestId("round-countdown");
    // Same clock-bar row, side by side.
    expect(countdown.parentElement).toBe(clock.parentElement);
    // And that row belongs to the arena column (main), never the header.
    const main = document.querySelector("main")!;
    const header = document.querySelector("header")!;
    expect(main.contains(countdown)).toBe(true);
    expect(header.contains(countdown)).toBe(false);
    expect(header.contains(clock)).toBe(false);
  });

  it("still disappears when the match is over", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });
    expect(screen.getByTestId("match-timer")).toBeInTheDocument();

    await feed(sockets, { phase: "finished", matchDeadline: deadline() });
    expect(screen.queryByTestId("match-timer")).toBeNull();
  });
});

describe("the roster column lives beside the arena", () => {
  it("renders the rail and the arena as siblings, rail first", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const rail = screen.getByTestId("match-rail");
    const main = document.querySelector("main")!;
    // Side by side: the rail is not inside the arena region…
    expect(main.contains(rail)).toBe(false);
    // …and it comes first, so it reads as the left-hand column.
    expect(rail.compareDocumentPosition(main)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("keeps the rail out of the header too", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });
    const header = document.querySelector("header")!;
    expect(header.contains(screen.getByTestId("match-rail"))).toBe(false);
  });
});
