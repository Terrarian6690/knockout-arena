// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  lastSent,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * QUICK PLAY — the public matchmaking entry point (Task 17).
 *
 * Driven against the REAL game server through the in-memory socket
 * harness, so these exercise the actual join_public round trip rather
 * than a mocked client.
 */

afterEach(() => {
  cleanup();
});

async function lobbyPlayer() {
  const harness = createServerHarness();
  const player = harness.addPlayer();
  const pair = await connectPlayer(player);
  renderLobby(player.client);
  return { harness, player, pair };
}

const quickPlayButton = () => screen.getByTestId("join-public");

describe("the Quick Play control", () => {
  it("is offered alongside the private room flow", async () => {
    await lobbyPlayer();

    expect(quickPlayButton()).toBeInTheDocument();
    // The private flow is untouched and still present.
    expect(screen.getByTestId("room-code-input")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create room/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join room/i })).toBeInTheDocument();
  });

  it("is a single action, not a room browser", async () => {
    await lobbyPlayer();
    // No list of joinable public games is rendered.
    expect(screen.queryByTestId("public-room-list")).toBeNull();
    expect(screen.getAllByTestId("join-public")).toHaveLength(1);
  });

  it("sends join_public with no room identifier", async () => {
    const { pair } = await lobbyPlayer();
    await act(async () => {
      fireEvent.click(quickPlayButton());
    });

    const sent = lastSent(pair);
    expect(sent.type).toBe("join_public");
    expect(sent).not.toHaveProperty("roomId");
  });

  it("seats the player in a public room", async () => {
    const { player } = await lobbyPlayer();
    await act(async () => {
      fireEvent.click(quickPlayButton());
    });

    await waitFor(() => {
      expect(player.client.getState().roomId).not.toBeNull();
    });
    expect(player.client.getState().playerId).toBe("p0");
  });

  it("is disabled until the connection is live", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client); // rendered, never connected
    expect(screen.getByTestId("join-public")).toBeDisabled();
  });

  it("clears a stale room-code error so it cannot look like a failure", async () => {
    await lobbyPlayer();
    // Provoke the client-side validation error on the private path.
    fireEvent.change(screen.getByTestId("room-code-input"), {
      target: { value: "!!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /join room/i }));
    expect(screen.getByTestId("join-error")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(quickPlayButton());
    });
    expect(screen.queryByTestId("join-error")).toBeNull();
  });
});

describe("two players quick-playing meet in one room", () => {
  it("the second player lands in the first player's room", async () => {
    const harness = createServerHarness();
    const one = harness.addPlayer();
    const two = harness.addPlayer();
    await connectPlayer(one);
    await connectPlayer(two);

    await act(async () => {
      one.client.joinPublicRoom();
    });
    await waitFor(() => expect(one.client.getState().roomId).not.toBeNull());

    await act(async () => {
      two.client.joinPublicRoom();
    });
    await waitFor(() => expect(two.client.getState().roomId).not.toBeNull());

    expect(two.client.getState().roomId).toBe(one.client.getState().roomId);
    expect(two.client.getState().playerId).toBe("p1");
  });

  it("a quick-played room reaches the normal pre-match lobby", async () => {
    const harness = createServerHarness();
    const one = harness.addPlayer();
    const two = harness.addPlayer();
    await connectPlayer(one);
    await connectPlayer(two);
    renderLobby(one.client);

    await act(async () => {
      fireEvent.click(quickPlayButton());
    });
    await waitFor(() => expect(one.client.getState().roomId).not.toBeNull());
    await act(async () => {
      two.client.joinPublicRoom();
    });

    // The ordinary room panel — same UI a private room shows.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /start match/i })).toBeInTheDocument();
    });
  });
});
