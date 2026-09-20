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
 * The HOST chip was REMOVED from every player list, so succession is no
 * longer visible as a label — what still must hold is that the
 * server-reported promotion REACHES every connected client (their
 * `hostPlayerId` state moves), that the promoted player's UI genuinely
 * becomes a host UI (the Start Match button), and that NO seat list
 * ever renders a host marker again.
 */

/** True when NO seat row in the tree carries a host marker. */
function noHostMarkerIn(container: HTMLElement): boolean {
  const list = within(container).queryByTestId("seat-list");
  if (list === null) return true;
  return !Array.from(list.querySelectorAll("li")).some((row) =>
    (row.textContent ?? "").includes("Host")
  );
}

describe("host succession without the HOST label", () => {
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

    // Everyone sees NO host marker on the seat rows (the chip is gone),
    // and every client knows who the host is.
    for (const view of [creatorView, secondView, thirdView]) {
      expect(noHostMarkerIn(view.container)).toBe(true);
    }
    expect(creator.client.getState().hostPlayerId).toBe("p0");
    expect(second.client.getState().hostPlayerId).toBe("p0");

    // The host leaves.
    await playerAct(() => creator.client.leaveRoom());

    // The promotion is broadcast to BOTH remaining clients — visible in
    // their state (and through the Start control), never as a label.
    expect(second.client.getState().hostPlayerId).toBe("p1");
    expect(third.client.getState().hostPlayerId).toBe("p1");
    expect(noHostMarkerIn(secondView.container)).toBe(true);
    expect(noHostMarkerIn(thirdView.container)).toBe(true);
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

    // p2 sees the new host in its state, but is not it — and no marker.
    expect(third.client.getState().hostPlayerId).toBe("p1");
    expect(noHostMarkerIn(thirdView.container)).toBe(true);
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
    expect(second.client.getState().hostPlayerId).toBe("p0");

    // The host's socket dies (not a leave) — the seat is reserved.
    await playerAct(() => creator.pairs[0]!.serverEnd.close());

    // No handover, and still no host marker on any seat row.
    expect(second.client.getState().hostPlayerId).toBe("p0"); // unchanged
    expect(noHostMarkerIn(secondView.container)).toBe(true);
    const seatRow = within(secondView.container).getByTestId("seat-p0");
    expect(within(seatRow).getByLabelText("disconnected")).toBeInTheDocument();
  });
});
