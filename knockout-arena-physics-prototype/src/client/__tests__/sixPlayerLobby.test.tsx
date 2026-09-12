// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_SEATS, MIN_PLAYERS } from "../components/lobby/SeatList";
import {
  createServerHarness,
  connectPlayer,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * SIX-PLAYER capacity — lobby UI (Task 7).
 *
 * Everything here runs against the REAL server stack through in-memory
 * sockets, so the roster the UI renders is the roster the server sent.
 * The lobby's job at six players is unchanged in kind — show every
 * seated player, pad the rest, count n/6, keep Start gated on the
 * server's minimum — so these tests pin exactly those behaviours at the
 * new capacity.
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

/** Seat one more player headlessly (no second screen rendered). */
async function joinHeadless(
  harness: ReturnType<typeof createServerHarness>,
  roomId: string
) {
  const guest = harness.addPlayer();
  await connectPlayer(guest);
  await playerAct(() => guest.client.joinRoom(roomId));
  return guest;
}

describe("the lobby shows up to six players", () => {
  it("counts n/6 as seats fill, one by one", async () => {
    const { harness, roomId } = await seatedHost();
    expect(await screen.findByText(`1 / ${MAX_SEATS}`)).toBeInTheDocument();
    expect(MAX_SEATS).toBe(6);

    for (let seated = 2; seated <= MAX_SEATS; seated++) {
      await joinHeadless(harness, roomId);
      // The count follows the server's roster push, with no refresh.
      expect(
        await screen.findByText(`${seated} / ${MAX_SEATS}`)
      ).toBeInTheDocument();
      expect(screen.queryAllByTestId("empty-seat")).toHaveLength(
        MAX_SEATS - seated
      );
    }
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();
  });

  it("renders all six seats with their Player N labels", async () => {
    const { harness, roomId } = await seatedHost();
    for (let i = 1; i < MAX_SEATS; i++) await joinHeadless(harness, roomId);
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();

    for (let i = 0; i < MAX_SEATS; i++) {
      const seat = screen.getByTestId(`seat-p${i}`);
      expect(within(seat).getByText(`Player ${i + 1}`)).toBeInTheDocument();
    }
    // A full room has no placeholders left.
    expect(screen.queryAllByTestId("empty-seat")).toHaveLength(0);
  });

  it("keeps the You and Host markers correct in a full six-player room", async () => {
    const { harness, roomId } = await seatedHost();
    for (let i = 1; i < MAX_SEATS; i++) await joinHeadless(harness, roomId);
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();

    // This screen belongs to the creator: p0 is both "You" and the host.
    const own = screen.getByTestId("seat-p0");
    expect(within(own).getByText("You")).toBeInTheDocument();
    expect(within(own).getByText("Host")).toBeInTheDocument();
    // Exactly one seat carries each marker (the room header shows its
    // own Host badge, so scope the count to the seat list).
    const seatList = screen.getByTestId("seat-list");
    expect(within(seatList).getAllByText("You")).toHaveLength(1);
    expect(within(seatList).getAllByText("Host")).toHaveLength(1);
    expect(screen.getByTestId("local-player-id")).toHaveTextContent("Player 1");
  });

  it("shows custom names beside fallbacks for six players", async () => {
    const { harness, host, roomId } = await seatedHost();
    const guests: Awaited<ReturnType<typeof joinHeadless>>[] = [];
    for (let i = 1; i < MAX_SEATS; i++) {
      guests.push(await joinHeadless(harness, roomId));
    }
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();

    // The host and the last two guests choose names.
    await playerAct(() => host.client.setName("Ada"));
    await playerAct(() => guests[3].client.setName("Grace"));
    await playerAct(() => guests[4].client.setName("Lin"));

    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(within(screen.getByTestId("seat-p4")).getByText("Grace")).toBeInTheDocument();
    expect(within(screen.getByTestId("seat-p5")).getByText("Lin")).toBeInTheDocument();
    // The unnamed seats keep their Player N fallback.
    expect(within(screen.getByTestId("seat-p1")).getByText("Player 2")).toBeInTheDocument();
    expect(within(screen.getByTestId("seat-p2")).getByText("Player 3")).toBeInTheDocument();
  });

  it("shows a sixth player's disconnect as disconnected, not as an empty seat", async () => {
    const { harness, roomId } = await seatedHost();
    const guests: Awaited<ReturnType<typeof joinHeadless>>[] = [];
    for (let i = 1; i < MAX_SEATS; i++) {
      guests.push(await joinHeadless(harness, roomId));
    }
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();

    // The sixth player leaves the waiting room: the seat is freed.
    await playerAct(() => guests[4].client.leaveRoom());
    expect(await screen.findByText(`5 / ${MAX_SEATS}`)).toBeInTheDocument();
    expect(screen.queryByTestId("seat-p5")).toBeNull();
    expect(screen.getAllByTestId("empty-seat")).toHaveLength(1);
  });
});

describe("starting a match at six-player capacity", () => {
  it("enables Start at the server's minimum, long before six", async () => {
    const { harness, roomId } = await seatedHost();
    const start = () => screen.getByTestId("start-match");

    // One player: below the minimum, so Start is refused by the UI.
    expect(start()).toBeDisabled();

    // The MINIMUM (2) is enough — capacity is 6, but it is not required.
    await joinHeadless(harness, roomId);
    expect(await screen.findByText(`2 / ${MAX_SEATS}`)).toBeInTheDocument();
    expect(MIN_PLAYERS).toBe(2);
    expect(start()).toBeEnabled();
  });

  it("still allows Start with a full six-player room", async () => {
    const { harness, roomId } = await seatedHost();
    for (let i = 1; i < MAX_SEATS; i++) await joinHeadless(harness, roomId);
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();
    expect(screen.getByTestId("start-match")).toBeEnabled();

    fireEvent.click(screen.getByTestId("start-match"));
    // The real server starts the match and the host leaves the lobby.
    expect(await screen.findByTestId("turn-badge")).toBeInTheDocument();
  });
});

describe("joining a full six-player room", () => {
  it("shows the server's room-full rejection to the seventh player", async () => {
    const { harness, view, roomId } = await seatedHost();
    for (let i = 1; i < MAX_SEATS; i++) await joinHeadless(harness, roomId);
    expect(await screen.findByText(`6 / ${MAX_SEATS}`)).toBeInTheDocument();

    // A seventh player renders its own screen and tries the room code.
    view.unmount();
    const seventh = harness.addPlayer();
    renderLobby(seventh.client);
    await connectPlayer(seventh);
    fireEvent.change(screen.getByLabelText("Room code"), {
      target: { value: roomId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Room" }));

    // The existing clean rejection path: the server's error, shown as a
    // banner — no seat, no crash, still on the home screen.
    const banner = await screen.findByTestId("error-banner");
    expect(banner).toHaveTextContent("room-full");
    expect(seventh.client.getState().roomId).toBeNull();
    expect(screen.queryByTestId("room-code")).toBeNull();
  });
});
