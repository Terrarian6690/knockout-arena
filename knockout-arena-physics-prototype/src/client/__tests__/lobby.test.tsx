// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { NetworkProvider } from "../network/react";
import { Lobby } from "../components/lobby/Lobby";
import {
  connectPlayer,
  createScriptedClient,
  createServerHarness,
  lastSent,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * Lobby initial screen: connection states, create/join room, and server
 * error display. Room-screen behavior (roster, host, start, leave,
 * transitions) lives in lobbyRoom.test.tsx.
 *
 * The real-server tests here drive the genuine server stack through
 * in-memory socket pairs — the server's own authorization and room rules
 * answer, never a client-side mock of them.
 */

describe("lobby initial screen", () => {
  it("renders the disconnected state: status badge shown, actions disabled", () => {
    const { client } = createScriptedClient();
    renderLobby(client);

    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Disconnected"
    );
    const create = screen.getByRole("button", { name: "Create Room" });
    const join = screen.getByRole("button", { name: "Join Room" });
    expect(create).toBeDisabled();
    expect(join).toBeDisabled();
    expect(screen.getByLabelText("Room code")).toBeDisabled();
    // A way back in is offered — reconnect goes through the client.
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeDefined();
  });

  it("renders the connecting state while the handshake is in flight", async () => {
    const { client, sockets } = createScriptedClient();
    renderLobby(client);

    await act(async () => {
      client.connect();
    });
    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Connecting…"
    );
    expect(screen.getByRole("button", { name: "Create Room" })).toBeDisabled();
    expect(screen.getByText("Connecting to the server…")).toBeDefined();
    expect(sockets).toHaveLength(1); // exactly one socket
  });

  it("connected but not in a room: actions enabled, no room panel", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Connected"
    );
    expect(screen.getByRole("button", { name: "Create Room" })).toBeEnabled();
    expect(screen.queryByTestId("room-panel")).toBeNull();
  });

  it("creates a room: create_room on the wire, then the server-reported room", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    const pair = await connectPlayer(player);

    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));

    // Exactly the protocol envelope, nothing else.
    expect(lastSent(pair)).toEqual({ protocolVersion: 1, type: "create_room" });
    expect(pair.clientSent).toHaveLength(1);

    // The room screen shows the SERVER-assigned room code and seat.
    const roomCode = player.client.getState().roomId as string;
    const shownCode = await screen.findByTestId("room-code");
    expect(shownCode).toHaveTextContent(roomCode);
    expect(screen.getByTestId("local-player-id")).toHaveTextContent("p0");
    expect(screen.getByTestId("room-state-badge")).toHaveTextContent(
      "Waiting for players"
    );
  });

  it("joins a room by code: join_room carries the normalized code, seat is server-assigned", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    const guest = harness.addPlayer();
    renderLobby(guest.client);
    const guestPair = await connectPlayer(guest);

    // The host creates a room (no UI needed for the host here).
    await connectPlayer(host);
    await playerAct(() => host.client.createRoom());
    const roomCode = host.client.getState().roomId as string;

    // Whitespace is tolerated around (and inside) the code — the client
    // normalizes before sending.
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: ` ${roomCode.slice(0, 2)} ${roomCode.slice(2)} ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    expect(lastSent(guestPair)).toEqual({
      protocolVersion: 1,
      type: "join_room",
      roomId: roomCode,
    });
    const shownCode = await screen.findByTestId("room-code");
    expect(shownCode).toHaveTextContent(roomCode);
    expect(screen.getByTestId("local-player-id")).toHaveTextContent("p1");
  });

  it("refuses to send join_room for an empty code (client-side form guard only)", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    const pair = await connectPlayer(player);

    expect(screen.getByRole("button", { name: "Join Room" })).toBeDisabled();
    // …and Enter in the input does nothing either.
    fireEvent.keyDown(screen.getByLabelText("Room code"), { key: "Enter" });
    expect(pair.clientSent).toHaveLength(0);
  });

  it("shows a server error normally: unknown room code, connection stays usable", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    // Well-formed code (so the client's shape guard passes) that no room
    // answers to: the server's unknown-room verdict is the error shown.
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: "ZZ9Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveTextContent("unknown-room");
    expect(screen.queryByTestId("room-panel")).toBeNull(); // still on the home screen

    // Dismissal is visual only; the connection itself is untouched.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Connected"
    );
  });

  it("an unexpected drop shows Reconnecting… and disables the actions", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    const pair = await connectPlayer(player);

    await act(async () => {
      pair.serverEnd.close(); // the network drops us
    });

    expect(screen.getByTestId("connection-status")).toHaveTextContent(
      "Reconnecting…"
    );
    expect(screen.getByRole("button", { name: "Create Room" })).toBeDisabled();
  });

  it("a reconnect attempt that succeeds restores the initial screen", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    const pair = await connectPlayer(player);

    await act(async () => {
      pair.serverEnd.close();
    });
    await waitFor(() => {
      expect(player.pairs.length).toBe(2); // the retry socket
    });
    await act(async () => {
      player.pairs[1].open();
    });

    expect(await screen.findByTestId("connection-status")).toHaveTextContent(
      "Connected"
    );
    expect(screen.getByRole("button", { name: "Create Room" })).toBeEnabled();
    // The seat did not survive the drop — nothing pretends it did.
    expect(screen.queryByTestId("room-panel")).toBeNull();
  });

  it("the practice-solo escape hatch calls back without touching the network", async () => {
    const onPracticeSolo = vi.fn();
    const { client } = createScriptedClient();
    render(
      <NetworkProvider client={client}>
        <Lobby onPracticeSolo={onPracticeSolo} />
      </NetworkProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: /Practice solo/ }));
    expect(onPracticeSolo).toHaveBeenCalledTimes(1);
    // The lobby never opened a connection by itself (injected client).
    expect(client.getState().status).toBe("disconnected");
  });
});
