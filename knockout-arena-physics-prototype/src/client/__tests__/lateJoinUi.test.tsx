// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * LATE JOIN, through the real UI: a player who joins a room while a
 * match is already running lands in the LOBBY with the
 * "Waiting for the current game to end…" banner — the game screen does
 * NOT take over (the running match's frozen roster is not theirs).
 */

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** The host's Start control (RoomPanel footer). */
const startButton = () => screen.getByTestId("start-match");

describe("joining a room with a running match", () => {
  it("keeps the late joiner in the lobby with the waiting banner", async () => {
    const harness = createServerHarness();

    // Host creates a room and starts a match with one guest.
    const host = harness.addPlayer();
    renderLobby(host.client);
    await connectPlayer(host);
    await playerAct(() => host.client.createRoom());
    await screen.findByTestId("room-code");

    const guest = harness.addPlayer();
    await connectPlayer(guest);
    const code = host.client.getState().roomId as string;
    await playerAct(() => guest.client.joinRoom(code));
    await waitFor(() =>
      expect(guest.client.getState().roster).toHaveLength(2)
    );

    // Start the match (the host's button).
    await playerAct(() => fireEvent.click(startButton()));
    await waitFor(() =>
      expect(host.client.getState().roomState).toBe("playing")
    );
    expect(screen.getByTestId("match-rail")).toBeInTheDocument();

    // A THIRD player joins mid-match, by code. (Their view is scoped:
    // the host's game screen is still mounted in the same document.)
    const late = harness.addPlayer();
    const lateScreen = renderLobby(late.client);
    await connectPlayer(late);
    await playerAct(() => late.client.joinRoom(code));
    await waitFor(() =>
      expect(late.client.getState().roster).toHaveLength(3)
    );

    // The late joiner's screen: still the lobby, with the banner — and
    // no game screen (the running match is not theirs).
    const view = within(lateScreen.container);
    expect(view.getByTestId("match-waiting-banner")).toHaveTextContent(
      "Waiting for the current game to end"
    );
    expect(view.queryByTestId("match-rail")).toBeNull();
    // Their seat shows in the list (connected, with the win counter).
    expect(view.getByTestId("seat-p2")).toBeInTheDocument();
    expect(view.getByTestId("wins-p2")).toHaveTextContent("wins: 0");
  });
});
