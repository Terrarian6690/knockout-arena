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
 * NO SPURIOUS "invalid-reconnect" ON A FRESH START (Task 19).
 *
 * THE BUG: the client kept its reconnect credential after the automatic
 * retry budget was exhausted. Retrying is the only thing that legitimately
 * replays a credential, so once the client stopped retrying, the token was
 * dead weight — and the next connect(), which the player experiences as
 * STARTING A FRESH GAME, replayed it and was greeted with
 * "the reconnect credential is invalid or expired".
 *
 * THE FIX: the credential (and the seat state held on its behalf) is
 * dropped at the moment recovery is abandoned. A credential is now only
 * ever sent by a retry that is still in flight.
 *
 * These tests deliberately assert on the WIRE (no reconnect frame) rather
 * than only on the absence of a banner: suppressing the message would
 * pass a UI-only assertion while leaving the bug in place.
 */

afterEach(() => {
  cleanup();
});

const tick = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** Every message type a player's client has put on the wire, in order. */
function framesOf(player: { pairs: Array<{ clientSent: string[] }> }): string[] {
  return player.pairs.flatMap((pair) =>
    pair.clientSent.map((raw) => (JSON.parse(raw) as { type: string }).type)
  );
}

/** Seat a player, then kill the connection and exhaust the retry budget. */
async function seatThenGiveUp(options?: { reconnectReservationMs?: number }) {
  const harness = createServerHarness(options, {
    reconnect: { maxAttempts: 1, baseDelayMs: 1 },
  });
  const player = harness.addPlayer();
  const pair = await connectPlayer(player);
  await act(async () => {
    player.client.joinPublicRoom();
  });
  await tick(30);

  await act(async () => {
    pair.serverEnd.close();
  });
  await tick(50);
  const retry = player.pairs[player.pairs.length - 1]!;
  if (retry !== pair) {
    await act(async () => {
      retry.serverEnd.close();
    });
  }
  await tick(150);
  return { harness, player };
}

describe("the reported bug: fresh start after recovery was abandoned", () => {
  it("sends no reconnect frame once retries are exhausted", async () => {
    const { harness, player } = await seatThenGiveUp();
    expect(player.client.getState().status).toBe("disconnected");
    const before = framesOf(player).length;

    // The server is restarted underneath (credential no longer exists) —
    // exactly the case that produced the reported message.
    harness.gameServer.destroy();
    await tick(20);

    await act(async () => {
      player.client.connect();
    });
    await tick(50);
    await act(async () => {
      player.pairs[player.pairs.length - 1]!.open();
    });
    await tick(150);

    const sentAfter = framesOf(player).slice(before);
    expect(sentAfter).not.toContain("reconnect");
  });

  it("shows no error banner on that fresh start", async () => {
    const { harness, player } = await seatThenGiveUp();
    harness.gameServer.destroy();
    await tick(20);

    await act(async () => {
      player.client.connect();
    });
    await tick(50);
    await act(async () => {
      player.pairs[player.pairs.length - 1]!.open();
    });
    await tick(150);

    expect(player.client.getState().lastError).toBeNull();
  });

  it("does not keep a seat it can no longer reclaim", async () => {
    const { player } = await seatThenGiveUp();
    // Room state was held on the credential's behalf; with recovery
    // abandoned, continuing to show a seat would be a lie.
    expect(player.client.getState().roomId).toBeNull();
    expect(player.client.getState().playerId).toBeNull();
    expect(player.client.getState().roster).toEqual([]);
  });

  it("can quick-join normally afterwards", async () => {
    const { harness, player } = await seatThenGiveUp();
    harness.gameServer.destroy();
    await tick(20);

    await act(async () => {
      player.client.connect();
    });
    await tick(50);
    await act(async () => {
      player.pairs[player.pairs.length - 1]!.open();
    });
    await tick(100);
    // A brand-new session on a brand-new server: an ordinary join works.
    expect(player.client.getState().lastError).toBeNull();
  });

  it("also stays clean when the window merely expired", async () => {
    // Same lifecycle, but the seat was released by the reservation
    // timeout rather than a restart. Still a fresh start, still silent.
    const { player } = await seatThenGiveUp({ reconnectReservationMs: 60 });
    await tick(200); // let the window close

    await act(async () => {
      player.client.connect();
    });
    await tick(50);
    await act(async () => {
      player.pairs[player.pairs.length - 1]!.open();
    });
    await tick(150);

    expect(player.client.getState().lastError).toBeNull();
    expect(framesOf(player)).not.toContain("reconnect");
  });
});

describe("normal fresh joins never carry a credential", () => {
  it("Quick Play sends only join_public", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);

    await act(async () => {
      fireEvent.click(screen.getByTestId("join-public"));
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    // join_public, then the set_name that applies the chosen name to the
    // new seat (Task 20's name gate) — and crucially NO credential.
    expect(framesOf(player)).toEqual(["join_public", "set_name", "set_skin"]);
    expect(player.client.getState().lastError).toBeNull();
  });

  it("Create Room sends only create_room", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create room/i }));
    });
    await waitFor(() => expect(player.client.getState().roomId).not.toBeNull());

    expect(framesOf(player)).toEqual(["create_room", "set_name", "set_skin"]);
    expect(player.client.getState().lastError).toBeNull();
  });

  it("joining a private room by code sends only join_room", async () => {
    const harness = createServerHarness();
    const host = harness.addPlayer();
    await connectPlayer(host);
    await act(async () => {
      host.client.createRoom();
    });
    await tick(30);
    const code = host.client.getState().roomId!;

    const friend = harness.addPlayer();
    await connectPlayer(friend);
    await act(async () => {
      friend.client.joinRoom(code);
    });
    await tick(50);

    // Driven through the network client directly (no rendered lobby, so
    // no name gate): the join frame stands alone.
    expect(framesOf(friend)).toEqual(["join_room"]);
    expect(friend.client.getState().lastError).toBeNull();
  });

  it("a leave followed by a new join carries nothing over", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    await act(async () => {
      player.client.joinPublicRoom();
    });
    await tick(30);
    await act(async () => {
      player.client.leaveRoom();
    });
    await tick(30);
    await act(async () => {
      player.client.joinPublicRoom();
    });
    await tick(50);

    expect(framesOf(player)).toEqual([
      "join_public",
      "leave_room",
      "join_public",
    ]);
    expect(player.client.getState().lastError).toBeNull();
  });
});

describe("genuine recovery is NOT weakened", () => {
  it("a retry within budget still replays the credential and reclaims the seat", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    const pair = await connectPlayer(player);
    await act(async () => {
      player.client.joinPublicRoom();
    });
    await tick(30);
    const roomId = player.client.getState().roomId;
    const playerId = player.client.getState().playerId;

    await act(async () => {
      pair.serverEnd.close();
    });
    await tick(150);
    const retry = player.pairs[player.pairs.length - 1]!;
    if (retry !== pair) {
      await act(async () => {
        retry.open();
      });
      await tick(150);
    }

    expect(framesOf(player)).toContain("reconnect");
    expect(player.client.getState().roomId).toBe(roomId);
    expect(player.client.getState().playerId).toBe(playerId);
    expect(player.client.getState().lastError).toBeNull();
  });

  it("a genuinely invalid credential still surfaces invalid-reconnect", async () => {
    // The message must never be suppressed — only stop being sent for
    // sessions that are not actually resuming.
    const harness = createServerHarness();
    const player = harness.addPlayer();
    const pair = await connectPlayer(player);
    await act(async () => {
      player.client.joinPublicRoom();
    });
    await tick(30);

    // Drop, then wipe the server's credential store before the retry.
    await act(async () => {
      pair.serverEnd.close();
    });
    await tick(80);
    harness.gameServer.destroy();
    const retry = player.pairs[player.pairs.length - 1]!;
    if (retry !== pair) {
      await act(async () => {
        retry.open();
      });
      await tick(150);
    }

    // The credential WAS legitimately in flight, so the rejection is real
    // and must still be reported.
    expect(framesOf(player)).toContain("reconnect");
    expect(player.client.getState().lastError?.code).toBe("invalid-reconnect");
    expect(player.client.getState().lastError?.message).toBe(
      "the reconnect credential is invalid or expired"
    );
  });

  it("an expired reservation still surfaces its specific message", async () => {
    const harness = createServerHarness({ reconnectReservationMs: 50 });
    const player = harness.addPlayer();
    const pair = await connectPlayer(player);
    await act(async () => {
      player.client.joinPublicRoom();
    });
    await tick(30);

    await act(async () => {
      pair.serverEnd.close();
    });
    // Let the window close before the retry lands.
    await tick(250);
    const retry = player.pairs[player.pairs.length - 1]!;
    if (retry !== pair) {
      await act(async () => {
        retry.open();
      });
      await tick(150);
    }

    expect(player.client.getState().lastError?.code).toBe("reservation-expired");
  });
});
