// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  connectPlayer,
  createScriptedClient,
  createServerHarness,
  playerAct,
  renderLobby,
  wire,
} from "./lobbyTestHarness";

/**
 * Lobby player list & start-match UX polish — the regression suite for
 * the room lobby's "who is here / can we start" surface.
 *
 * What these tests pin:
 *   - the player list: friendly "Player N" labels (the server's own pawn
 *     naming — never raw seat ids), the local player marked You, the host
 *     marked Host, connected/disconnected state as TEXT (not color only),
 *     empty seats as "Waiting for player…" placeholders, and the n / 4
 *     player count (with an accessible label);
 *   - live updates: a player joining or leaving appears/disappears from
 *     the list WITHOUT a refresh — straight from the server's room_state
 *     broadcasts (no polling, no second list that could diverge);
 *   - start-match UX: the button exists only for the host, is disabled
 *     below the server's 2-player minimum (with a plain-language reason),
 *     arms itself when a second player seats, shows the "Starting…"
 *     pending state while the server decides (scripted socket — the
 *     pending window is not reliably observable against the real
 *     in-memory server), recovers cleanly from a server rejection, and
 *     the real server moves BOTH clients into the match together;
 *   - leave: the leaver returns to the home surface with the room view
 *     gone, while the room itself stays server-authoritative;
 *   - the Task 14 room-code surface keeps working alongside the list.
 *
 * Real-server tests drive the genuine stack through in-memory socket
 * pairs; the pending/rejection test uses a scripted socket so the timing
 * stays in the test's hands.
 */

/** A rendered, connected host sitting in its freshly created room. */
async function seatedHost() {
  const harness = createServerHarness();
  const host = harness.addPlayer();
  const view = renderLobby(host.client);
  await connectPlayer(host);
  fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
  await screen.findByTestId("room-code");
  return { harness, host, view };
}

/** Seat a second player headless (no rendered tree): the room's guest. */
async function seatGuest(
  harness: ReturnType<typeof createServerHarness>,
  host: { getState: () => { roomId: string | null } }
) {
  const guest = harness.addPlayer();
  await connectPlayer(guest);
  await playerAct(() => guest.client.joinRoom(host.getState().roomId as string));
  return guest;
}

describe("lobby player list", () => {
  it("shows friendly labels, the local player, empty seats and the count", async () => {
    const { host } = await seatedHost();

    // Friendly label (the server's own pawn naming), You + Host chips,
    // connection state as text.
    const ownSeat = screen.getByTestId("seat-p0");
    expect(within(ownSeat).getByText("Player 1")).toBeInTheDocument();
    expect(within(ownSeat).getByText("You")).toBeInTheDocument();
    expect(within(ownSeat).getByText("Host")).toBeInTheDocument();
    expect(within(ownSeat).getByText("Connected")).toBeInTheDocument();
    expect(screen.getByTestId("local-player-id")).toHaveTextContent(
      "Player 1"
    );

    // Empty seats are explicit placeholders, not blank space.
    const emptySeats = screen.getAllByTestId("empty-seat");
    expect(emptySeats).toHaveLength(3);
    for (const emptySeat of emptySeats) {
      expect(emptySeat).toHaveTextContent("Waiting for player…");
    }

    // The count is visible and accessible.
    const count = screen.getByTestId("player-count");
    expect(count).toHaveTextContent("1 / 4");
    expect(count).toHaveAttribute("aria-label", "1 of 4 players");

    // Task 14's room-code surface is still there next to the list.
    expect(screen.getByTestId("room-code")).toHaveTextContent(
      host.client.getState().roomId as string
    );
    expect(screen.getByTestId("copy-code")).toBeInTheDocument();
  });

  it("identifies the local player on the guest's screen too", async () => {
    const { harness, host, view } = await seatedHost();
    const guest = await seatGuest(harness, host.client);

    // One rendered tree at a time (the established pattern).
    view.unmount();
    renderLobby(guest.client);
    await screen.findByTestId("seat-p1");

    const ownSeat = screen.getByTestId("seat-p1");
    expect(within(ownSeat).getByText("Player 2")).toBeInTheDocument();
    expect(within(ownSeat).getByText("You")).toBeInTheDocument();
    expect(within(ownSeat).queryByText("Host")).toBeNull();
    const otherSeat = screen.getByTestId("seat-p0");
    expect(within(otherSeat).getByText("Player 1")).toBeInTheDocument();
    expect(within(otherSeat).getByText("Host")).toBeInTheDocument();
    expect(within(otherSeat).queryByText("You")).toBeNull();
    expect(screen.getByTestId("local-player-id")).toHaveTextContent(
      "Player 2"
    );
    expect(screen.getByTestId("player-count")).toHaveTextContent("2 / 4");
  });

  it("updates the list live when a player joins (no refresh)", async () => {
    const { harness, host } = await seatedHost();
    expect(screen.getByTestId("player-count")).toHaveTextContent("1 / 4");

    await seatGuest(harness, host.client);

    // The roster push alone updates the rendered list.
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();
    expect(screen.getByTestId("seat-p1")).toBeInTheDocument();
    expect(screen.getAllByTestId("empty-seat")).toHaveLength(2);
  });

  it("updates the list live when a player leaves (no refresh)", async () => {
    const { harness, host } = await seatedHost();
    const guest = await seatGuest(harness, host.client);
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();

    // The guest leaves on purpose: in the waiting room the seat is freed,
    // and the host's list shrinks from the server's roster broadcast.
    await playerAct(() => guest.client.leaveRoom());

    expect(await screen.findByText("1 / 4")).toBeInTheDocument();
    expect(screen.queryByTestId("seat-p1")).toBeNull();
    expect(screen.getAllByTestId("empty-seat")).toHaveLength(3);
  });

  it("marks a dropped player disconnected — as text, not just color", async () => {
    const { harness, host } = await seatedHost();
    const guest = await seatGuest(harness, host.client);
    expect(await screen.findByTestId("seat-p1")).toBeInTheDocument();

    // An unexpected drop: the seat stays (reserved for reconnect) but is
    // reported disconnected by the server's next roster push.
    await playerAct(() => guest.client.close());

    const droppedSeat = await screen.findByTestId("seat-p1");
    expect(within(droppedSeat).getByText("Disconnected")).toBeInTheDocument();
    expect(
      within(droppedSeat).getByRole("img", { name: "disconnected" })
    ).toBeInTheDocument();
    expect(host.client.getState().roster[1].connected).toBe(false);
  });
});

describe("start-match UX", () => {
  it("hides the button from non-hosts, showing the waiting note instead", async () => {
    const { harness, host, view } = await seatedHost();
    const guest = await seatGuest(harness, host.client);

    view.unmount();
    renderLobby(guest.client);
    await screen.findByTestId("seat-p1");

    expect(screen.queryByTestId("start-match")).toBeNull();
    expect(screen.getByTestId("waiting-for-host")).toHaveTextContent(
      "Waiting for the host to start the match"
    );
  });

  it("disables Start below the server's 2-player minimum, with a reason", async () => {
    const { harness, host } = await seatedHost();

    // The host alone: the button is visible but disabled, and the room
    // says WHY — a UX mirror of the server's not-enough-players rule.
    expect(screen.getByTestId("start-match")).toBeDisabled();
    expect(screen.getByTestId("waiting-for-players")).toHaveTextContent(
      "Waiting for another player"
    );

    // A second player seats (live): the button arms, the hint disappears.
    await seatGuest(harness, host.client);
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();
    expect(screen.getByTestId("start-match")).toBeEnabled();
    expect(screen.queryByTestId("waiting-for-players")).toBeNull();
  });

  it("starts the match through the real server: both clients transition", async () => {
    const { harness, host } = await seatedHost();
    const guest = await seatGuest(harness, host.client);
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("start-match"));
    // The start intent went on the wire; the real server starts the match
    // and the lobby hands the screen to the game view — while the guest's
    // store flips to playing too (one authoritative room, two views).
    expect(
      await screen.findByText("Multiplayer match", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("room-panel")).toBeNull();
    expect(screen.queryByTestId("start-match")).toBeNull();
    expect(guest.client.getState().roomState).toBe("playing");
  });

  it("shows Starting… while the server decides and recovers from rejection", async () => {
    const { client, sockets } = createScriptedClient();
    renderLobby(client);
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
      // The server seats us as host with two players — a startable room.
      sockets[0].serverMessage(
        wire.welcome(
          "p0",
          "K7P4",
          [
            { playerId: "p0", connected: true },
            { playerId: "p1", connected: true },
          ],
          "p0"
        )
      );
    });

    const start = screen.getByTestId("start-match");
    expect(start).toBeEnabled();

    fireEvent.click(start);
    // Pending feedback immediately; the click cannot double-fire.
    expect(start).toHaveTextContent("Starting…");
    expect(start).toBeDisabled();
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      protocolVersion: 1,
      type: "start_match",
    });

    // The server says no (e.g. the other player left a beat earlier):
    // the pending state resets, the error shows, the button re-arms.
    await act(async () => {
      sockets[0].serverMessage(
        wire.error("not-enough-players", "the match needs at least 2 players")
      );
    });
    expect(screen.getByTestId("start-match")).toHaveTextContent("Start Match");
    expect(screen.getByTestId("start-match")).toBeEnabled();
    const banner = screen.getByTestId("error-banner");
    expect(banner).toHaveTextContent("not-enough-players");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByTestId("error-banner")).toBeNull();
  });
});

describe("leave room (from the player list screen)", () => {
  it("returns the leaver to the home screen; the room stays server-authoritative", async () => {
    const { harness, host } = await seatedHost();
    const guest = await seatGuest(harness, host.client);
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();

    // Leave: a clearly labelled action that cannot start anything.
    fireEvent.click(screen.getByTestId("leave-room"));

    // The leaver is back on the home surface (view-level navigation —
    // protocol v1 sends no leave ack) and no room UI lingers.
    expect(
      await screen.findByRole("button", { name: "Create Room" })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("room-panel")).toBeNull();
    expect(screen.queryByTestId("room-code")).toBeNull();

    // The remaining player's room is intact and its list shrank — the
    // server, not the leaver's client, owns that truth.
    expect(guest.client.getState().roomState).toBe("waiting");
    expect(guest.client.getState().roster).toHaveLength(1);
  });
});
