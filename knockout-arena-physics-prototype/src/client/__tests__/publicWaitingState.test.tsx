// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * LONE-PLAYER WAITING STATE IN PUBLIC ROOMS (Task 18).
 *
 * Driven against the REAL server through the in-memory socket harness,
 * so the waiting state is derived from actual server frames rather than
 * a client-side guess.
 *
 * The product decision pinned here: the wait is INDEFINITE. No timeout,
 * no bot fill, no auto-cancel — the only exits are another player
 * arriving or the player pressing Leave.
 */

afterEach(() => {
  cleanup();
});

async function soloPublicPlayer() {
  const harness = createServerHarness();
  const player = harness.addPlayer();
  await connectPlayer(player);
  renderLobby(player.client);
  await act(async () => {
    player.client.joinPublicRoom();
  });
  await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());
  return { harness, player };
}

/** A second player who quick-joins into the same public room. */
async function addSecondPlayer(harness: ReturnType<typeof createServerHarness>) {
  const two = harness.addPlayer();
  await connectPlayer(two);
  await act(async () => {
    two.client.joinPublicRoom();
  });
  await waitFor(() => expect(two.client.getState().roomId).not.toBeNull());
  return two;
}

describe("a lone player in a public room", () => {
  it("sees a waiting hint", async () => {
    await soloPublicPlayer();
    expect(screen.getByTestId("waiting-for-players")).toHaveTextContent(
      /waiting for another player/i
    );
  });

  it("is told how someone will arrive", async () => {
    await soloPublicPlayer();
    expect(screen.getByTestId("public-waiting-hint")).toHaveTextContent(
      /quick play/i
    );
  });

  it("always has a leave action available", async () => {
    await soloPublicPlayer();
    const leave = screen.getByTestId("leave-room");
    expect(leave).toBeInTheDocument();
    expect(leave).toBeEnabled();
  });

  it("has no start control at all, and no countdown yet", async () => {
    await soloPublicPlayer();
    // TASK 28: a public room has no player-initiated start whatsoever —
    // the button is gone rather than merely disabled. With one player
    // the server has armed nothing, so no countdown shows either.
    expect(screen.queryByTestId("start-match")).toBeNull();
    expect(screen.queryByTestId("auto-start-countdown")).toBeNull();
  });

  it("knows the room is public from server data, not a guess", async () => {
    const { player } = await soloPublicPlayer();
    expect(player.client.getState().roomVisibility).toBe("public");
    expect(player.client.getState().roster).toHaveLength(1);
    expect(player.client.getState().roomState).toBe("waiting");
  });

  it("is not shown a room code or invite link it cannot use", async () => {
    // Task 17 made public rooms unreachable via the code field, so
    // offering one here would hand the player a dead link.
    await soloPublicPlayer();
    expect(screen.queryByTestId("room-code")).toBeNull();
    expect(screen.queryByTestId("copy-code")).toBeNull();
    expect(screen.getByTestId("public-room-label")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/share this code/i);
  });

  it("waits indefinitely — nothing cancels it on a timer", async () => {
    const { player } = await soloPublicPlayer();
    const roomId = player.client.getState().roomId;

    // Let plenty of wall-clock pass with real timers running.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(player.client.getState().roomId).toBe(roomId);
    expect(screen.getByTestId("waiting-for-players")).toBeInTheDocument();
    expect(screen.getByTestId("leave-room")).toBeInTheDocument();
  });
});

describe("when a second player joins", () => {
  it("the waiting hint disappears for the first player", async () => {
    const { harness } = await soloPublicPlayer();
    expect(screen.getByTestId("waiting-for-players")).toBeInTheDocument();

    await addSecondPlayer(harness);

    // Snapshot-driven: the server's roster broadcast removes the hint.
    await waitFor(() => {
      expect(screen.queryByTestId("waiting-for-players")).toBeNull();
    });
    expect(screen.queryByTestId("public-waiting-hint")).toBeNull();
  });

  it("the server arms an auto-start countdown instead of a start button", async () => {
    // TASK 28: reaching two players no longer enables a control — it
    // schedules the match. The countdown is what the player now sees.
    const { harness } = await soloPublicPlayer();
    await addSecondPlayer(harness);

    await waitFor(() => {
      expect(screen.getByTestId("auto-start-countdown")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("start-match")).toBeNull();
  });

  it("the roster reflects both players", async () => {
    const { harness, player } = await soloPublicPlayer();
    await addSecondPlayer(harness);

    await waitFor(() => {
      expect(player.client.getState().roster).toHaveLength(2);
    });
  });

  it("no stale waiting UI lingers anywhere on screen", async () => {
    const { harness } = await soloPublicPlayer();
    await addSecondPlayer(harness);

    await waitFor(() => {
      expect(screen.queryByTestId("waiting-for-players")).toBeNull();
    });
    expect(document.body.textContent ?? "").not.toMatch(
      /waiting for another player/i
    );
  });

  it("the hint returns if that player leaves again", async () => {
    const { harness } = await soloPublicPlayer();
    const two = await addSecondPlayer(harness);
    await waitFor(() => {
      expect(screen.queryByTestId("waiting-for-players")).toBeNull();
    });

    await act(async () => {
      two.client.leaveRoom();
    });

    // Back to the lone-player state, driven entirely by server frames.
    await waitFor(() => {
      expect(screen.getByTestId("waiting-for-players")).toBeInTheDocument();
    });
  });
});

describe("leaving from the waiting state", () => {
  it("returns the player to the join screen", async () => {
    await soloPublicPlayer();
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });

    // The entry screen is back, with both ways in.
    await waitFor(() => {
      expect(screen.getByTestId("join-public")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /create room/i })).toBeInTheDocument();
    expect(screen.queryByTestId("waiting-for-players")).toBeNull();
  });

  it("releases the seat server-side", async () => {
    const { harness, player } = await soloPublicPlayer();
    const roomId = player.client.getState().roomId;
    expect(harness.gameServer.roomCount()).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });

    // The lone player's departure empties and destroys the room.
    await waitFor(() => {
      expect(harness.gameServer.roomCount()).toBe(0);
    });
    expect(roomId).not.toBeNull();
  });

  it("uses the same leave path as a private room", async () => {
    // Not a bespoke public-room exit: the shared leave_room frame.
    const harness = createServerHarness();
    const player = harness.addPlayer();
    const pair = await connectPlayer(player);
    renderLobby(player.client);
    await act(async () => {
      player.client.joinPublicRoom();
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });
    const sent = pair.clientSent.map((raw) => JSON.parse(raw) as { type: string });
    expect(sent.some((m) => m.type === "leave_room")).toBe(true);
  });

  it("lets the player immediately quick-join again", async () => {
    const { player } = await soloPublicPlayer();
    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("join-public")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("join-public"));
    });
    await waitFor(() => {
      expect(player.client.getState().roomId).not.toBeNull();
    });
    expect(player.client.getState().playerId).toBe("p0");
  });

  it("does not strand the other player when one of two leaves", async () => {
    const { harness, player } = await soloPublicPlayer();
    const two = await addSecondPlayer(harness);
    await waitFor(() => expect(player.client.getState().roster).toHaveLength(2));

    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });

    // The room survives with the remaining player, seat released.
    await waitFor(() => {
      expect(two.client.getState().roster).toHaveLength(1);
    });
    expect(harness.gameServer.roomCount()).toBe(1);
  });
});

describe("private rooms are unaffected", () => {
  it("still show their code and invite affordances", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);
    await act(async () => {
      player.client.createRoom();
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    expect(screen.getByTestId("room-code")).toBeInTheDocument();
    expect(screen.getByTestId("copy-code")).toBeInTheDocument();
    expect(player.client.getState().roomVisibility).toBe("private");
  });

  it("show no waiting sentence at all — the disabled Start says it", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);
    await act(async () => {
      player.client.createRoom();
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    // Task 29: the private room's waiting line was redundant next to
    // its own disabled Start button, so it is gone. The public hint was
    // never shown here and still is not.
    expect(screen.queryByTestId("waiting-for-players")).toBeNull();
    expect(screen.queryByTestId("public-waiting-hint")).toBeNull();
    // The control that carries the meaning is still present.
    expect(screen.getByTestId("start-match")).toBeDisabled();
  });

  it("still leave through the same control", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);
    await act(async () => {
      player.client.createRoom();
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("join-public")).toBeInTheDocument();
    });
    expect(harness.gameServer.roomCount()).toBe(0);
  });
});
