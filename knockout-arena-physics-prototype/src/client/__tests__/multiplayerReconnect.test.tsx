// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GameStateSnapshot } from "../../game";
import {
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * Seat recovery through the REAL stack and the REAL UI: a player's
 * connection drops mid-match or in the waiting room, the screen keeps the
 * match/room context while the network client runs its reconnect
 * handshake, and the SAME seat (playerId, match, turn) comes back. An
 * expired credential returns the player to the lobby home.
 *
 * Only one React tree is rendered (the host's); the guest is driven
 * headless through the same real server, exactly like
 * multiplayerIntegration.test.tsx.
 */

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return predicate();
}

/** Wait for the client's retry socket to exist, then complete its open. */
async function openRetrySocket(
  player: { pairs: Array<{ open: () => void }> },
  timeoutMs = 3000
): Promise<void> {
  expect(
    await waitFor(() => player.pairs.length > 1, timeoutMs)
  ).toBe(true);
  await act(async () => {
    player.pairs[player.pairs.length - 1].open();
  });
}

describe("seat recovery through the real UI", () => {
  it("a mid-match drop keeps the game screen and recovers the same seat", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();

    renderLobby(host.client);
    await connectPlayer(host);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = host.client.getState().roomId as string;

    await connectPlayer(guest);
    await playerAct(() => guest.client.joinRoom(roomId));
    fireEvent.click(screen.getByTestId("start-match"));
    expect(await screen.findByText("Multiplayer match", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      await waitFor(() => host.client.getState().snapshot !== null, 5000)
    ).toBe(true);
    expect(screen.getByTestId("turn-badge")).toHaveTextContent(
      "Choose your move — aim!"
    );

    // ── the host's connection dies mid-match ──
    await act(async () => {
      host.pairs[0].serverEnd.close();
    });
    // The game screen STAYS (the seat is server-reserved) with the
    // reconnect banner; no lobby, no result overlay, no fake state.
    expect(screen.getByText(/Connection lost — retrying/)).toBeInTheDocument();
    expect(screen.getByTestId("arena-canvas")).toBeInTheDocument();
    expect(host.client.getState().roomId).toBe(roomId);
    expect(host.client.getState().status).toBe("reconnecting");

    // The guest sees the host's seat reported disconnected…
    expect(
      await waitFor(
        () =>
          guest.client.getState().roster.some(
            (seat) => seat.playerId === "p0" && !seat.connected
          ),
        3000
      )
    ).toBe(true);

    // ── the retry lands: same seat, same match ──
    await openRetrySocket(host);
    expect(
      await waitFor(() => host.client.getState().status === "connected", 3000)
    ).toBe(true);
    expect(host.client.getState().roomId).toBe(roomId);
    expect(host.client.getState().playerId).toBe("p0");
    expect(host.client.getState().roomState).toBe("playing");

    // The banner is gone, the match view is intact…
    expect(screen.queryByText(/Connection lost — retrying/)).not.toBeInTheDocument();
    expect(screen.getByText("Multiplayer match")).toBeInTheDocument();
    expect(screen.getByTestId("turn-badge")).toHaveTextContent("Choose your move — aim!");

    // …the guest sees the host connected again…
    expect(
      await waitFor(
        () =>
          guest.client.getState().roster.every((seat) => seat.connected),
        3000
      )
    ).toBe(true);

    // …and the recovered player's commands flow to the server again.
    fireEvent.pointerMove(screen.getByTestId("arena-canvas"), {
      clientX: 120,
      clientY: 80,
    });
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).isAiming === true,
        5000
      )
    ).toBe(true);
    expect(
      (host.client.getState().snapshot as GameStateSnapshot).localPawnId
    ).toBe("p0"); // recovered into the same seat's own view

    // One room, two seats, one host identity — nothing duplicated.
    expect(harness.gameServer.getRoom(roomId)!.seats).toHaveLength(2);
    expect(harness.gameServer.getRoom(roomId)!.seats[0]).toEqual({
      playerId: "p0",
      connected: true,
    });
  }, 15000);

  it("a waiting-room drop keeps the room panel and recovers the same seat", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();

    renderLobby(host.client);
    await connectPlayer(host);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = host.client.getState().roomId as string;

    await connectPlayer(guest);
    await playerAct(() => guest.client.joinRoom(roomId));
    expect(host.client.getState().roster).toHaveLength(2);

    // ── the host's connection dies while waiting ──
    await act(async () => {
      host.pairs[0].serverEnd.close();
    });
    // The room panel STAYS with the reconnect hint — same room context.
    expect(screen.getByText(/Connection lost — retrying/)).toBeInTheDocument();
    expect(screen.getByTestId("start-match")).toBeDisabled(); // not connected
    expect(host.client.getState().roomId).toBe(roomId);
    expect(host.client.getState().playerId).toBe("p0");

    // A third player cannot steal the reserved seat meanwhile.
    const intruder = harness.addPlayer();
    await connectPlayer(intruder);
    await playerAct(() => intruder.client.joinRoom(roomId));
    expect(intruder.client.getState().playerId).toBe("p2"); // p0's seat is reserved

    // ── recovery: same seat, same room, host again ──
    await openRetrySocket(host);
    expect(
      await waitFor(() => host.client.getState().status === "connected", 3000)
    ).toBe(true);
    expect(host.client.getState().roomId).toBe(roomId);
    expect(host.client.getState().playerId).toBe("p0");
    expect(host.client.getState().hostPlayerId).toBe("p0");
    expect(screen.queryByText(/Connection lost — retrying/)).not.toBeInTheDocument();
    expect(screen.getByTestId("start-match")).toBeEnabled();
    expect(harness.gameServer.getRoom(roomId)!.seats).toHaveLength(3);
  }, 15000);

  it("an expired credential returns the player to the lobby home with the error", async () => {
    // Reservation window (40 ms) shorter than the client's first retry
    // (150 ms): by the time the handshake is sent, the seat is gone.
    const harness = createServerHarness(
      { reconnectReservationMs: 40 },
      { reconnect: { baseDelayMs: 150 } }
    );
    const host = harness.addPlayer();

    renderLobby(host.client);
    await connectPlayer(host);
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    const roomId = host.client.getState().roomId as string;
    expect(screen.getByTestId("start-match")).toBeInTheDocument(); // in the room panel

    await act(async () => {
      host.pairs[0].serverEnd.close();
    });
    expect(screen.getByText(/Connection lost — retrying/)).toBeInTheDocument();

    // The retry happens after the window closed: the server rejects the
    // credential and the client honestly clears the seat state.
    await openRetrySocket(host, 5000);
    expect(
      await waitFor(() => host.client.getState().status === "connected", 3000)
    ).toBe(true);
    expect(
      await screen.findByText("Enter the arena", {}, { timeout: 3000 })
    ).toBeInTheDocument(); // back home
    expect(screen.getByTestId("error-banner")).toHaveTextContent(
      "invalid-reconnect"
    );
    expect(host.client.getState().roomId).toBeNull();
    expect(host.client.getState().playerId).toBeNull();

    // The room was removed once the reservation expired with nobody left.
    expect(harness.gameServer.getRoom(roomId)).toBeNull();

    // And the player can immediately start over with a fresh room.
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    expect(
      await waitFor(() => host.client.getState().roomId !== null, 3000)
    ).toBe(true);
    expect(host.client.getState().playerId).toBe("p0");
    expect(screen.getByTestId("start-match")).toBeInTheDocument();
  }, 15000);
});
