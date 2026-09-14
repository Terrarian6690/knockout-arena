// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * HOST SUCCESSION IN THE UI (Task 26) — real server, real transport, real
 * network clients, real Lobby components over in-memory sockets.
 *
 * The HOST chip and the Start Match button are pure functions of the
 * server-reported `hostPlayerId`, so what actually needs proving is that
 * the promotion REACHES every connected client (not just the promoted
 * one) and that the promoted player's UI genuinely becomes a host UI.
 */

/** The HOST chip currently rendered in a given tree's seat list. */
function hostSeatIn(container: HTMLElement): string | null {
  const list = within(container).queryByTestId("seat-list");
  if (list === null) return null;
  for (const row of Array.from(list.querySelectorAll("li"))) {
    if ((row.textContent ?? "").includes("Host")) {
      return row.getAttribute("data-testid");
    }
  }
  return null;
}

describe("the HOST label follows succession in every client", () => {
  it("moves to the promoted player for BOTH remaining clients", async () => {
    const harness = createServerHarness();
    const creator = harness.addPlayer();
    const second = harness.addPlayer();
    const third = harness.addPlayer();

    // The creator's own screen.
    const creatorView = renderLobby(creator.client);
    await connectPlayer(creator);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = creator.client.getState().roomId as string;

    // Two more players, each with their OWN rendered lobby.
    await connectPlayer(second);
    await playerAct(() => second.client.joinRoom(roomId));
    const secondView = renderLobby(second.client, { playerName: "Second" });

    await connectPlayer(third);
    await playerAct(() => third.client.joinRoom(roomId));
    const thirdView = renderLobby(third.client, { playerName: "Third" });

    // Everyone agrees the creator is host.
    expect(hostSeatIn(creatorView.container)).toBe("seat-p0");
    expect(hostSeatIn(secondView.container)).toBe("seat-p0");
    expect(hostSeatIn(thirdView.container)).toBe("seat-p0");

    // The host leaves.
    await playerAct(() => creator.client.leaveRoom());

    // Both remaining clients see the chip move to p1 — the promotion is
    // broadcast, not just known to the promoted player.
    expect(hostSeatIn(secondView.container)).toBe("seat-p1");
    expect(hostSeatIn(thirdView.container)).toBe("seat-p1");
    expect(second.client.getState().hostPlayerId).toBe("p1");
    expect(third.client.getState().hostPlayerId).toBe("p1");
  });

  it("gives the promoted player a working Start Match button", async () => {
    const harness = createServerHarness();
    const creator = harness.addPlayer();
    const second = harness.addPlayer();
    const third = harness.addPlayer();

    renderLobby(creator.client);
    await connectPlayer(creator);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = creator.client.getState().roomId as string;

    await connectPlayer(second);
    await playerAct(() => second.client.joinRoom(roomId));
    const secondView = renderLobby(second.client, { playerName: "Second" });

    await connectPlayer(third);
    await playerAct(() => third.client.joinRoom(roomId));

    // Before succession p1 is an ordinary player: no start control.
    expect(
      within(secondView.container).queryByTestId("start-match")
    ).not.toBeInTheDocument();

    await playerAct(() => creator.client.leaveRoom());

    // After succession the button appears, enabled (2 players remain).
    const start = within(secondView.container).getByTestId("start-match");
    expect(start).toBeEnabled();

    // And it really starts the match on the server.
    await playerAct(() => fireEvent.click(start));
    expect(harness.gameServer.getRoom(roomId)!.state).toBe("playing");
  });

  it("does not offer the start control to a non-promoted player", async () => {
    const harness = createServerHarness();
    const creator = harness.addPlayer();
    const second = harness.addPlayer();
    const third = harness.addPlayer();

    renderLobby(creator.client);
    await connectPlayer(creator);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = creator.client.getState().roomId as string;

    await connectPlayer(second);
    await playerAct(() => second.client.joinRoom(roomId));
    await connectPlayer(third);
    await playerAct(() => third.client.joinRoom(roomId));
    const thirdView = renderLobby(third.client, { playerName: "Third" });

    await playerAct(() => creator.client.leaveRoom());

    // p2 sees the new host, but is not it.
    expect(hostSeatIn(thirdView.container)).toBe("seat-p1");
    expect(
      within(thirdView.container).queryByTestId("start-match")
    ).not.toBeInTheDocument();
  });

  it("keeps the chip on a dropped host who is still inside their window", async () => {
    // A reconnect-eligible drop must NOT look like a handover: the chip
    // stays put and the seat simply shows as disconnected.
    const harness = createServerHarness();
    const creator = harness.addPlayer();
    const second = harness.addPlayer();

    renderLobby(creator.client);
    await connectPlayer(creator);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = creator.client.getState().roomId as string;

    await connectPlayer(second);
    await playerAct(() => second.client.joinRoom(roomId));
    const secondView = renderLobby(second.client, { playerName: "Second" });
    expect(hostSeatIn(secondView.container)).toBe("seat-p0");

    // The host's socket dies (not a leave) — the seat is reserved.
    await playerAct(() => creator.pairs[0]!.serverEnd.close());

    expect(hostSeatIn(secondView.container)).toBe("seat-p0"); // unchanged
    expect(second.client.getState().hostPlayerId).toBe("p0");
    const seatRow = within(secondView.container).getByTestId("seat-p0");
    expect(within(seatRow).getByLabelText("disconnected")).toBeInTheDocument();
  });
});
