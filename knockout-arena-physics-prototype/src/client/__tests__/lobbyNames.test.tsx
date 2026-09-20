// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_SEATS } from "../components/lobby/SeatList";
import {
  connectPlayer,
  createServerHarness,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * Display names in the waiting room.
 *
 * The in-room RENAME EDITOR was removed on request: a player's name is
 * chosen on the home screen, before entering a room, and cannot be
 * changed while waiting. What is still true and pinned here:
 *
 *   - the waiting room renders NO name editor at all (and none returns
 *     once the match starts — names freeze into the match);
 *   - remote players' names appear live (roster broadcasts only);
 *   - players without a name keep the seat-derived "Player N" fallback;
 *   - Unicode names round-trip through the real stack;
 *   - the name survives an unexpected drop + reconnect (same seat, same
 *     name — the name lives on the server's seat, never locally);
 *   - the server is the authority: its roster push is what renames.
 *
 * All flows run against the REAL server stack through in-memory socket
 * pairs — nothing is mocked. Names are driven through the client
 * directly (client.setName), exactly the call the removed editor used
 * to make — the roster UI under test is the same.
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

/** Wait until the predicate returns truthy; returns it (or null on timeout). */
async function waitFor<T>(
  predicate: () => T | null | false,
  timeoutMs = 3000
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return null;
}

describe("display names in the waiting room", () => {
  it("renders NO name editor in the waiting room", async () => {
    await seatedHost();

    // The rename box was removed on request: the name is set on the
    // home screen and the waiting room only ever DISPLAYS it.
    expect(screen.queryByTestId("display-name-input")).toBeNull();
    expect(screen.queryByLabelText("Player name:")).toBeNull();
    // The roster itself is, of course, still here.
    expect(screen.getByTestId("seat-p0")).toBeInTheDocument();
  });

  it("no editor appears while playing either — names freeze into the match", async () => {
    const { harness, host } = await seatedHost();
    const guest = harness.addPlayer();
    await connectPlayer(guest);
    await playerAct(() =>
      guest.client.joinRoom(host.client.getState().roomId as string)
    );
    expect(await screen.findByText(`2 / ${MAX_SEATS}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("start-match"));
    await screen.findByTestId("multiplayer-game", {}, { timeout: 5000 });

    // The waiting room never had an editor to take away — and the match
    // screen has none either.
    expect(screen.queryByLabelText("Player name:")).toBeNull();
    expect(screen.queryByTestId("display-name-input")).toBeNull();
  });

  it("remote players' names appear live; unnamed players keep the fallback", async () => {
    const { harness, host } = await seatedHost();
    const guest = harness.addPlayer();
    await connectPlayer(guest);
    await playerAct(() =>
      guest.client.joinRoom(host.client.getState().roomId as string)
    );
    expect(await screen.findByTestId("seat-p1")).toBeInTheDocument();

    // The guest names themselves headless — the host's list follows the
    // server's roster broadcast, no refresh.
    await playerAct(() => guest.client.setName("  Żółć  "));

    const guestSeat = await waitFor(() => {
      const seat = screen.getByTestId("seat-p1");
      return seat.textContent?.includes("Żółć") ? seat : null;
    });
    expect(guestSeat).not.toBeNull();

    // A player who never set a name keeps the seat-derived fallback. The
    // rendered host is named by the lobby's name gate, so the unnamed
    // subject is a third seat driven headless (a bare network client has
    // no UI gate to pass).
    const unnamed = harness.addPlayer();
    await connectPlayer(unnamed);
    await playerAct(() =>
      unnamed.client.joinRoom(host.client.getState().roomId as string)
    );
    const unnamedSeat = await waitFor(() =>
      screen.queryByTestId("seat-p2")
    );
    expect(unnamedSeat).not.toBeNull();
    expect(unnamedSeat!).toHaveTextContent("Player 3");
  });

  it("renaming again updates everyone (change, not just set)", async () => {
    const { harness, host } = await seatedHost();
    const guest = harness.addPlayer();
    await connectPlayer(guest);
    await playerAct(() =>
      guest.client.joinRoom(host.client.getState().roomId as string)
    );
    await playerAct(() => guest.client.setName("Alex"));
    expect(await screen.findByText(`2 / ${MAX_SEATS}`)).toBeInTheDocument();

    // The guest changes their name; the host sees the new one.
    await playerAct(() => guest.client.setName("Alexandra"));
    const seat = await waitFor(() => {
      const s = screen.getByTestId("seat-p1");
      return s.textContent?.includes("Alexandra") ? s : null;
    });
    expect(seat).not.toBeNull();
    // The OLD name is gone (exact text, not a substring check).
    expect(within(seat as HTMLElement).getByText("Alexandra")).toBeInTheDocument();
    expect(within(seat as HTMLElement).queryByText("Alex")).toBeNull();
  });

  it("the name survives an unexpected drop and reconnect (same seat)", async () => {
    const { host } = await seatedHost();
    await playerAct(() => host.client.setName("Szymon"));
    expect(await screen.findByText("Szymon")).toBeInTheDocument();

    // Unexpected drop: the seat is reserved; the client retries.
    host.pairs[0].serverEnd.close();
    const retryAppeared = await waitFor(() => host.pairs.length > 1, 5000);
    expect(retryAppeared).toBe(true);
    await act(async () => {
      host.pairs[host.pairs.length - 1].open();
    });

    // The recovered welcome carries the same seat AND the same name —
    // the name lives on the server's seat, never in the credential.
    await waitFor(
      () =>
        host.client.getState().status === "connected" &&
        host.client.getState().playerId === "p0"
    );
    const seat = await waitFor(() => {
      const s = screen.getByTestId("seat-p0");
      return s.textContent?.includes("Szymon") ? s : null;
    });
    expect(seat).not.toBeNull();
    expect(within(seat as HTMLElement).getByText("You")).toBeInTheDocument();
  });
});
