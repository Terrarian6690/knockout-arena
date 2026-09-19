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
 * Requested (and then revised): the clock now lives CENTRED IN THE TOP
 * BAR. It previously floated over the arena just under the header —
 * that kept the board full height, but left the readout drifting in the
 * play area. The top bar is the screen's status strip, and dead centre
 * is where the eye lands.
 *
 * What has to stay true:
 *
 *   - it is inside the header, and horizontally CENTRED on the screen —
 *     not merely "somewhere between the logo and the controls", which
 *     is what a plain flex row would give (the logo is much wider than
 *     the controls, so the midpoint of the leftover space is not the
 *     midpoint of the screen);
 *   - it must not overlap the arena or the shrink warning any more;
 *   - it still vanishes when the match ends.
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

describe("the match clock sits centred in the top bar", () => {
  it("lives inside the header", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(header!.contains(timer)).toBe(true);
  });

  it("no longer floats over the arena", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const timer = screen.getByTestId("match-timer");
    const main = document.querySelector("main")!;
    // The arena region no longer contains it…
    expect(main.contains(timer)).toBe(false);
    // …and the canvas is still there, undisturbed.
    expect(main.contains(screen.getByTestId("arena-canvas"))).toBe(true);
  });

  it("is centred on the SCREEN, not on the space left between its neighbours", async () => {
    // A flex row with justify-between would push the clock to the
    // midpoint of the leftover gap, which is off-centre because the
    // logo is far wider than the controls. A three-track grid with
    // equal outer tracks (1fr auto 1fr) is what actually centres it.
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const header = document.querySelector("header")!;
    expect(header.className).toContain("grid");
    expect(header.className).toContain("grid-cols-[1fr_auto_1fr]");

    // The clock sits in the middle track: exactly one element between
    // the logo's track and the controls' track.
    const tracks = Array.from(header.children);
    expect(tracks).toHaveLength(3);
    expect(tracks[1].contains(screen.getByTestId("match-timer"))).toBe(true);
    // The outer tracks hold the logo and the controls, in that order.
    expect(tracks[0].querySelector("h1")).not.toBeNull();
    expect(tracks[2].contains(screen.getByTestId("audio-toggle"))).toBe(true);
  });

  it("is bigger than it was — the clock is the bar's focal point", async () => {
    // jsdom has no layout engine, so this pins the type scale: the
    // digits are text-2xl (1.5rem), up from the old text-lg (1.125rem).
    const { sockets } = await renderGame();
    await feed(sockets, { matchDeadline: deadline() });

    const digits = screen.getByTestId("match-timer-clock");
    expect(digits.className).toContain("text-2xl");
    expect(digits.className).not.toContain("text-lg");
  });

  it("frees the arena's overlay band for the shrink warning", async () => {
    // The warning used to be padded down (pt-14) purely to clear the
    // floating clock. With the clock gone from the arena it returns to
    // the top of the band, where it is noticed soonest.
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
      return token === undefined ? 0 : Number(token.slice(2 + 1));
    };
    expect(topPad(band.className)).toBeLessThanOrEqual(2);
    // And it is still the non-interactive overlay it always was.
    expect(band.className).toContain("pointer-events-none");
    expect(band.className).toContain("absolute");
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
