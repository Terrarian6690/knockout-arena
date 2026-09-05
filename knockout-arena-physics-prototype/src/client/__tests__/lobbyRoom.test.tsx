// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  connectPlayer,
  createScriptedClient,
  createServerHarness,
  lastSent,
  playerAct,
  renderLobby,
  wire,
} from "./lobbyTestHarness";

/**
 * Lobby room screen: roster rendering, host identification, the host-only
 * Start Match button, leave room, the full room, and the waiting →
 * starting → playing → finished transitions.
 *
 * Real-server tests (in-memory socket pairs into the genuine server stack)
 * cover everything the server authorizes; scripted sockets cover the pure
 * UI feedback states whose timing we want to control. Where a test needs
 * two players' screens, one screen is rendered at a time (the other player
 * acts headless) so every assertion is unambiguous.
 */

/** A rendered, connected host sitting in its freshly created room. */
async function seatedHost() {
  const harness = createServerHarness();
  const host = harness.addPlayer();
  const view = renderLobby(host.client);
  await connectPlayer(host);
  fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
  expect(await screen.findByTestId("room-code")).toBeInTheDocument();
  return {
    harness,
    host,
    view,
    roomId: host.client.getState().roomId as string,
  };
}

/** Join `roomId` with a second player — rendered or headless. */
async function joinRoom(
  harness: ReturnType<typeof createServerHarness>,
  roomId: string,
  options: { render?: boolean } = {}
) {
  const guest = harness.addPlayer();
  const view = options.render === false ? null : renderLobby(guest.client);
  const pair = await connectPlayer(guest);
  if (view === null) {
    await playerAct(() => guest.client.joinRoom(roomId));
  } else {
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: roomId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));
    expect(await screen.findByTestId("room-code")).toHaveTextContent(roomId);
  }
  return { guest, view, pair };
}

describe("lobby room screen", () => {
  it("renders the roster: seated players and empty seats, from server data", async () => {
    const { harness, host, roomId } = await seatedHost();
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    expect(screen.getByTestId("seat-p0")).toBeInTheDocument();
    expect(screen.getAllByTestId("empty-seat")).toHaveLength(3);

    // A second player joins; the host's roster updates from the broadcast.
    await joinRoom(harness, roomId, { render: false });
    expect(await screen.findByText("2 / 4")).toBeInTheDocument();
    expect(screen.getByTestId("seat-p0")).toBeInTheDocument();
    expect(screen.getByTestId("seat-p1")).toBeInTheDocument();
    expect(screen.getAllByTestId("empty-seat")).toHaveLength(2);
    expect(host.client.getState().roster).toHaveLength(2); // store = server truth
  });

  it("identifies the host from server data: Host chip on the host seat, You on your own", async () => {
    const { harness, view, roomId } = await seatedHost();
    // The host sees its own seat flagged as both Host and You.
    expect(within(screen.getByTestId("seat-p0")).getByText("Host")).toBeInTheDocument();
    expect(within(screen.getByTestId("seat-p0")).getByText("You")).toBeInTheDocument();

    // Now the guest's screen (host view unmounted; one tree at a time).
    view.unmount();
    await joinRoom(harness, roomId);

    const p0 = screen.getByTestId("seat-p0");
    expect(within(p0).getByText("Host")).toBeInTheDocument();
    expect(within(p0).queryByText("You")).toBeNull();
    const p1 = screen.getByTestId("seat-p1");
    expect(within(p1).getByText("You")).toBeInTheDocument();
    expect(within(p1).queryByText("Host")).toBeNull();
    expect(screen.getByTestId("local-player-id")).toHaveTextContent("p1");
  });

  it("shows the Start Match button only to the server-reported host", async () => {
    const { harness, view, roomId } = await seatedHost();
    // Host view: the button exists and is enabled.
    expect(screen.getByTestId("start-match")).toBeEnabled();

    // Guest view: no start button at all — just the waiting note.
    view.unmount();
    await joinRoom(harness, roomId);
    expect(screen.queryByTestId("start-match")).toBeNull();
    expect(screen.getByTestId("waiting-for-host")).toBeInTheDocument();
  });

  it("a non-host start attempt surfaces the server's unauthorized error normally", async () => {
    const { harness, view, roomId } = await seatedHost();
    view.unmount();
    const { guest } = await joinRoom(harness, roomId);

    // A tampered client sends start_match anyway: the UI must not bypass
    // anything — it simply displays the server's rejection.
    await playerAct(() => guest.client.startMatch());

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveTextContent("unauthorized");
    // Still in the room, still waiting — the room state is unchanged
    // because the server said so, not because the UI decided.
    expect(screen.getByTestId("room-state-badge")).toHaveTextContent(
      "Waiting for players"
    );
  });

  it("leave room sends leave_room and returns to the initial screen", async () => {
    const { harness, view, roomId } = await seatedHost();
    view.unmount();
    const { pair } = await joinRoom(harness, roomId);

    fireEvent.click(screen.getByTestId("leave-room"));
    expect(lastSent(pair)).toEqual({ protocolVersion: 1, type: "leave_room" });
    // Protocol v1 does not acknowledge the leave to the leaver: returning
    // home is a view-level navigation; the server stays authoritative.
    expect(
      await screen.findByRole("button", { name: "Create Room" })
    ).toBeEnabled();
    expect(screen.queryByTestId("room-panel")).toBeNull();
  });

  it("the room tells the others when someone leaves", async () => {
    const { harness, roomId } = await seatedHost();
    const { guest } = await joinRoom(harness, roomId, { render: false });

    await playerAct(() => guest.client.leaveRoom());

    // Host view: back to one seated player, three empty seats.
    expect(await screen.findByText("1 / 4")).toBeInTheDocument();
    expect(screen.queryByTestId("seat-p1")).toBeNull();
    expect(screen.getAllByTestId("empty-seat")).toHaveLength(3);
  });

  it("starting: the host's click shows Starting… until the server answers", async () => {
    const { client, sockets } = createScriptedClient();
    renderLobby(client);
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
      sockets[0].serverMessage(wire.welcome("p0", "r1"));
    });

    fireEvent.click(screen.getByTestId("start-match"));
    expect(screen.getByTestId("start-match")).toHaveTextContent("Starting…");
    expect(screen.getByTestId("start-match")).toBeDisabled();
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      protocolVersion: 1,
      type: "start_match",
    });

    // The server moves the room on → the lobby hands the screen to the
    // multiplayer game (no local guessing).
    await act(async () => {
      sockets[0].serverMessage(
        wire.roomState(
          "playing",
          [
            { playerId: "p0", connected: true },
            { playerId: "p1", connected: true },
          ],
          "p0"
        )
      );
    });
    expect(screen.getByText("Multiplayer match")).toBeInTheDocument();
    expect(screen.queryByTestId("start-match")).toBeNull();
  });

  it("waiting → playing through the real server: the game screen takes over", async () => {
    const { harness, host, roomId } = await seatedHost();
    await joinRoom(harness, roomId, { render: false }); // guest joins, no UI

    fireEvent.click(screen.getByTestId("start-match"));

    // The lobby hands the screen to the multiplayer game once the server
    // reports playing — and the first authoritative snapshot arrives.
    expect(await screen.findByText("Multiplayer match")).toBeInTheDocument();
    expect(
      await screen.findByTestId("turn-badge")
    ).toHaveTextContent("Choose your move — aim!");
    expect(screen.queryByTestId("start-match")).toBeNull();
    expect(host.client.getState().roomState).toBe("playing"); // server truth
  });

  it("shows the full four-player room, then rejects a fifth joiner with the server error", async () => {
    const { harness, view, roomId } = await seatedHost();
    await joinRoom(harness, roomId, { render: false });
    await joinRoom(harness, roomId, { render: false });
    await joinRoom(harness, roomId, { render: false });

    expect(await screen.findByText("4 / 4")).toBeInTheDocument();
    for (const seat of ["p0", "p1", "p2", "p3"]) {
      expect(screen.getByTestId(`seat-${seat}`)).toBeInTheDocument();
    }
    expect(screen.queryAllByTestId("empty-seat")).toHaveLength(0);

    // A fifth player (rendered) tries to join: the server's verdict shows.
    view.unmount();
    const fifth = harness.addPlayer();
    renderLobby(fifth.client);
    await connectPlayer(fifth);
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: roomId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveTextContent("room-full");
    expect(screen.queryByTestId("room-panel")).toBeNull();
  });

  it("finished: the winner comes from the server's snapshot + match_finished", async () => {
    const { client, sockets } = createScriptedClient();
    renderLobby(client);
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
      sockets[0].serverMessage(
        wire.welcome(
          "p1",
          "r1",
          [
            { playerId: "p0", connected: true },
            { playerId: "p1", connected: true },
          ],
          "p0"
        )
      );
      sockets[0].serverMessage(
        wire.roomState(
          "playing",
          [
            { playerId: "p0", connected: true },
            { playerId: "p1", connected: true },
          ],
          "p0"
        )
      );
    });

    // The finished snapshot arrives first, then the announcement.
    await act(async () => {
      sockets[0].serverMessage(
        wire.snapshot(
          { phase: "finished", winnerId: "p0", localPawnId: "p1" },
          { p1: { isLocal: true }, p0: { isLocal: false } }
        )
      );
      sockets[0].serverMessage(wire.matchFinished("p0"));
    });

    expect(client.getState().roomState).toBe("finished");
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("Player 1 wins the match.");
    // The leave action is the way out (no reset button in the lobby).
    expect(screen.getByTestId("back-to-lobby")).toBeInTheDocument();
  });
});
