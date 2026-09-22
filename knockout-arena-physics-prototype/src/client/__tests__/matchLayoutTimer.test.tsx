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
 * Requested (supersedes the earlier "own bar below the top bar" design):
 * the timers — the match clock AND the round decision countdown — live
 * IN THE MAIN TOP BAR, next to the logo; the strip that used to sit
 * between the top bar and the arena is GONE, so the arena gets the full
 * remaining height. Things that have to stay true, and are easy to
 * break by accident:
 *
 *   - both timers render inside the <header> (the top bar);
 *   - NO clock bar exists anywhere — nothing sits between the top bar
 *     and the arena but the arena itself;
 *   - the clocks still disappear when the match is over;
 *   - the shrink warning keeps overlaying the canvas on its own band;
 *   - the eliminated player's notice also lives in the top bar — it
 *     never covers the board (see eliminatedNotice.test.tsx).
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

describe("the match clocks live in the top bar", () => {
  it("both timers are inside the header (the main top bar)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {
      matchDeadline: deadline(),
      roundDeadline: Date.now() + 5_000,
    });

    const header = document.querySelector("header")!;
    expect(header).not.toBeNull();
    expect(header.contains(screen.getByTestId("match-timer"))).toBe(true);
    expect(header.contains(screen.getByTestId("round-countdown"))).toBe(true);
  });

  it("no clock bar exists between the top bar and the arena", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    // The old strip is gone…
    expect(screen.queryByTestId("clock-bar")).toBeNull();
    // …and the arena is the FIRST child of its column (its wrapper —
    // nothing sits between the top bar and the board).
    const main = document.querySelector("main")!;
    const canvas = screen.getByTestId("arena-canvas");
    expect(main.firstElementChild).toBe(canvas.parentElement);
  });

  it("the timers are NOT inside the arena column", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {
      matchDeadline: deadline(),
      roundDeadline: Date.now() + 5_000,
    });

    const main = document.querySelector("main")!;
    expect(main.contains(screen.getByTestId("match-timer"))).toBe(false);
    expect(
      main.contains(screen.getByTestId("round-countdown"))
    ).toBe(false);
  });

  it("both clocks still disappear when the match is over", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {
      matchDeadline: deadline(),
      roundDeadline: Date.now() + 5_000,
    });
    expect(screen.getByTestId("match-timer")).toBeInTheDocument();
    expect(screen.getByTestId("round-countdown")).toBeInTheDocument();

    await feed(sockets, { phase: "finished", matchDeadline: deadline() });
    expect(screen.queryByTestId("match-timer")).toBeNull();
    expect(screen.queryByTestId("round-countdown")).toBeNull();
  });

  it("the shrink warning overlays the canvas on its own band", async () => {
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

    const band = screen.getByTestId("shrink-warning").parentElement!;
    // The warning is an arena overlay (and the only one at its top —
    // the clocks are in the header, structurally unable to collide).
    expect(band.className).toContain("absolute");
  });

  it("no longer makes the shrink warning reserve room for the clocks", async () => {
    // The clocks are in the top bar, so the warning's top padding is a
    // small value — the old large clearance (pt-14, sized to clear a
    // clock badge) would push the warning oddly far down the board.
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
