// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * THE ELIMINATED PLAYER'S DEATH NOTICE.
 *
 * When the local pawn leaves the arena the match keeps going without
 * them — and the player must SEE that they are out: a compact red
 * "Knocked out!" badge IN THE TOP BAR (💥, role=alert), on screen for
 * as long as they are spectating — and NEVER over the arena (the
 * board stays 100% visible to the spectator). It stands down when the
 * finished phase hands the screen to the match result overlay.
 */

afterEach(cleanup);

/** Render the game screen directly and open the scripted socket. */
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
  overrides: Record<string, unknown> = {},
  pawnOverrides: Record<string, Record<string, unknown>> = {}
) {
  await act(async () => {
    sockets[0].serverMessage(wire.snapshot(overrides, pawnOverrides));
  });
}

describe("EliminatedNotice (the local player's death notice)", () => {
  it("an alive player sees no notice", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {});
    expect(screen.queryByTestId("eliminated-notice")).toBeNull();
  });

  it("the eliminated player gets a prominent on-screen death message", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { eliminated: true } });

    const notice = screen.getByTestId("eliminated-notice");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent("Knocked out!");
    expect(notice).toHaveTextContent("watching the rest of the match");
    // Announced assertively: being eliminated is the one event the
    // player must hear even mid-spectation.
    expect(screen.getByRole("alert")).toBe(notice.querySelector("[role=alert]"));
  });

  it("stands down once the match is finished (the result overlay owns the screen)", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { eliminated: true } });
    expect(screen.getByTestId("eliminated-notice")).toBeInTheDocument();

    await feed(sockets, { phase: "finished", winnerId: "p1" });
    expect(screen.queryByTestId("eliminated-notice")).toBeNull();
  });

  it("lives in the TOP BAR — never over the arena — and stays inert", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { eliminated: true } });

    const notice = screen.getByTestId("eliminated-notice");
    // The whole point: the board is never covered — the badge sits in
    // the main top bar, OUTSIDE the arena column.
    const header = document.querySelector("header")!;
    expect(header.contains(notice)).toBe(true);
    expect(document.querySelector("main")!.contains(notice)).toBe(false);
    // Inert by construction; and it never re-enables capture.
    expect(notice.className).toContain("pointer-events-none");
    expect(notice.querySelector(".pointer-events-auto")).toBeNull();
  });
});
