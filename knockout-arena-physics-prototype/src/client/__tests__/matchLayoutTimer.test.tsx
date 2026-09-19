// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * THE MATCH CLOCK'S PLACE ON SCREEN.
 *
 * Requested: the "time left in the match" readout belongs BELOW the top
 * bar on the arena screen, not crammed into the header next to the logo
 * and the connection badge.
 *
 * It floats over the top of the arena, which keeps the board's height
 * intact. Two things therefore have to stay true, and both are easy to
 * break by accident:
 *
 *   - it must not capture pointer events (the arena underneath is the
 *     aiming surface — a clock that ate clicks would silently break
 *     aiming near the top edge);
 *   - it must not collide with the shrink warning, which occupies the
 *     same overlay band.
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

  it("floats over the arena without stealing aim clicks", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const overlay = timer.parentElement!;
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).toContain("pointer-events-none");
    // The badge itself must not re-enable pointer capture.
    expect(timer.className).not.toContain("pointer-events-auto");
  });

  it("shares the arena with the canvas rather than displacing it", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const main = document.querySelector("main")!;
    // Overlaying the arena region is what keeps the board full height.
    expect(main.contains(timer)).toBe(true);
    expect(main.contains(screen.getByTestId("arena-canvas"))).toBe(true);
  });

  it("does not overlap the shrink warning's band", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const overlay = screen.getByTestId("match-timer").parentElement!;
    // Both overlays pin to the top of the arena, so the clock has to sit
    // in a higher stacking layer than the warning's z-10.
    expect(overlay.className).toContain("z-20");
  });

  it("leaves the shrink warning padded clear of the clock", async () => {
    // Both overlays are pinned to top-0 of the arena, so they would be
    // drawn on top of each other unless the warning is pushed down past
    // the clock. jsdom has no layout engine and cannot measure the
    // overlap, so the guarantee is pinned on the padding itself: the
    // warning's top padding must exceed the clock's.
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

    const clockBand = screen.getByTestId("match-timer").parentElement!;
    // The warning must actually be on screen, or this test proves
    // nothing about the two of them colliding.
    const band = screen.getByTestId("shrink-warning").parentElement!;

    const topPad = (cls: string): number => {
      const token = cls.split(" ").find((c) => c.startsWith("pt-"));
      return token === undefined ? 0 : Number(token.slice(3));
    };
    // jsdom has no layout engine, so the clearance is pinned on the
    // padding arithmetic instead. Merely being "greater" is not enough:
    // the clock badge is itself about 32px tall (text-lg + py-1), so the
    // warning has to clear the clock's own offset PLUS that height, or
    // the two still overlap on screen. Tailwind's scale is 4px per step,
    // so 32px is 8 steps.
    const CLOCK_HEIGHT_STEPS = 8;
    expect(topPad(band.className)).toBeGreaterThanOrEqual(
      topPad(clockBand.className) + CLOCK_HEIGHT_STEPS
    );
    // …and the clock's own band stays a thin strip at the very top.
    expect(topPad(clockBand.className)).toBeLessThanOrEqual(4);
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
    // Same overlay row, side by side.
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
