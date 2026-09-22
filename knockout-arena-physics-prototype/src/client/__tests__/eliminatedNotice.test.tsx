// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * THE ELIMINATED PLAYER'S DEATH NOTICE.
 *
 * When the local pawn leaves the arena the match keeps going without
 * them — and the player must SEE that they are out: the red "Knocked
 * out!" card over the arena (💥, role=alert), in the same spot as
 * always — now with an OK BUTTON that clears it for good (until a NEW
 * elimination). It stands down when the finished phase hands the
 * screen to the match result overlay; only the card itself takes
 * pointer input (the button), the wrapper stays inert.
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
    expect(notice).toHaveTextContent(
      "Your pawn left the arena — watching the rest of the match."
    );
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

  it("floats over the arena (the same spot as before); the card is tappable", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { eliminated: true } });

    const notice = screen.getByTestId("eliminated-notice");
    // Lives inside the arena column, above the board — the same spot
    // as before, now with the OK control.
    expect(document.querySelector("main")!.contains(notice)).toBe(true);
    const header = document.querySelector("header")!;
    expect(header.contains(notice)).toBe(false);
    // The WRAPPER stays inert; only the card (the OK button) takes input.
    expect(notice.className).toContain("pointer-events-none");
    const card = notice.querySelector("[role=alert]")!;
    expect(card.className).toContain("pointer-events-auto");
    expect(screen.getByTestId("dismiss-eliminated-notice")).toHaveTextContent(
      "OK"
    );
  });

  it("the OK button clears the notice for good — until a NEW elimination", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, {}, { p0: { eliminated: true } });
    expect(screen.getByTestId("eliminated-notice")).toBeInTheDocument();

    // Acknowledge: the notice disappears…
    await act(async () => {
      fireEvent.click(screen.getByTestId("dismiss-eliminated-notice"));
    });
    expect(screen.queryByTestId("eliminated-notice")).toBeNull();

    // …and STAYS dismissed while the elimination episode continues.
    await feed(sockets, {}, { p0: { eliminated: true } });
    expect(screen.queryByTestId("eliminated-notice")).toBeNull();

    // The match ends; the notice is irrelevant (the result overlay owns
    // the screen) and the dismissal re-arms.
    await feed(sockets, { phase: "finished", winnerId: "p1" });
    expect(screen.queryByTestId("eliminated-notice")).toBeNull();

    // A NEW game knocks the player out again → the notice shows again.
    await feed(sockets, {}, { p0: {} });
    await feed(sockets, {}, { p0: { eliminated: true } });
    expect(screen.getByTestId("eliminated-notice")).toBeInTheDocument();
  });
});
