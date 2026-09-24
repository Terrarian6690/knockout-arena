// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkProvider } from "../network/react";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * The phone viewport contract: the layout must live in what the user
 * can actually SEE, not in the 100vh that includes the strip under the
 * browser's bottom bar (that burial put the control bar into the "cut
 * off" part of the screen), and the bar itself lifts over the gesture
 * area with a 10px clearance.
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

describe("the match screen's phone viewport", () => {
  it("sizes the layout with the dynamic viewport (100dvh), 100vh only as fallback", async () => {
    await renderGame();
    const root = screen.getByTestId("multiplayer-game");
    // Inline style wins where dvh is supported; the h-screen class
    // remains for the browsers where the inline value is dropped.
    expect(root.style.height).toBe("100dvh");
    expect(root.className).toContain("h-screen");
  });

  it("the control bar clears the bottom gesture area with 10px to spare", async () => {
    await renderGame();
    const bar = screen.getByTestId("match-controls");
    expect(bar.className).toContain(
      "max-sm:pb-[calc(env(safe-area-inset-bottom)+10px)]"
    );
  });
});
