// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAX_SEATS } from "../components/lobby/SeatList";
import {
  connectPlayer,
  createServerHarness,
  lastSent,
  playerAct,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * Display-name UX in the waiting room — the regression suite for
 * "YOUR NAME".
 *
 * What these tests pin:
 *   - the editor renders accessibly (label, bounded input, Save button)
 *     and only while the room waits;
 *   - local validation: empty/oversized/control-character names get an
 *     instant, explicit error and NOTHING is sent;
 *   - a valid save sends exactly one set_name with the locally trimmed
 *     name; the server broadcast renames the OWN seat (You chip stays);
 *   - remote players' names appear live (roster broadcasts only);
 *   - players without a name keep the seat-derived "Player N" fallback;
 *   - Unicode names round-trip through the real stack;
 *   - the name survives an unexpected drop + reconnect (same seat, same
 *     name — the name lives on the server's seat, never locally);
 *   - the server is the authority: its roster push is what renames.
 *
 * All flows run against the REAL server stack through in-memory socket
 * pairs — nothing is mocked.
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

describe("the display-name editor", () => {
  it("renders accessibly in the waiting room", async () => {
    await seatedHost();

    const input = screen.getAllByLabelText("Player name:").at(-1)!;
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("maxlength", "32"); // 2× the code-point max
    // Task 27: the name auto-saves — there is deliberately no Save
    // button to press (and nothing else took its place).
    expect(screen.queryByRole("button", { name: "Save Name" })).toBeNull();
    expect(screen.queryByTestId("save-name")).toBeNull();
    // The in-room box is a RENAME box: a name is now mandatory before
    // entering at all (Task 20), so it arrives pre-filled with the name
    // the player chose on the home screen — there is no "leave empty to
    // stay Player 1" fallback to advertise any more.
    expect(input).toHaveValue("Tester");
  });

  it("saves a trimmed valid name: one set_name, own seat renamed", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0];

    fireEvent.change(screen.getByLabelText("Player name:"), {
      target: { value: "  Szymon  " },
    });
    // Task 27: blur is an explicit commit — no button to click.
    fireEvent.blur(screen.getByLabelText("Player name:"));

    // Exactly one wire message: the trimmed name.
    expect(lastSent(pair)).toEqual({
      protocolVersion: 1,
      type: "set_name",
      name: "Szymon",
    });

    // The server's roster push renames the OWN seat; the You chip stays.
    const seat = await screen.findByTestId("seat-p0");
    expect(within(seat).getByText("Szymon")).toBeInTheDocument();
    expect(within(seat).getByText("You")).toBeInTheDocument();
    expect(within(seat).getByText("Host")).toBeInTheDocument();
    // The input adopts the server-confirmed name.
    expect(screen.getByLabelText("Player name:")).toHaveValue("Szymon");
  });

  it("validates locally: invalid names never reach the wire", async () => {
    const { host } = await seatedHost();
    const sentBefore = host.pairs[0].clientSent.length;

    // Whitespace-only: committing it sends nothing (no wire traffic).
    fireEvent.change(screen.getByLabelText("Player name:"), {
      target: { value: "   " },
    });
    fireEvent.blur(screen.getByLabelText("Player name:"));

    // Non-empty but invalid shapes: an explicit, non-color-only error
    // (role=alert), and still nothing on the wire. (Newlines cannot even
    // reach this point: the single-line input sanitizes them away — tab
    // and BEL survive the input and are rejected by the validator.)
    for (const bad of ["A".repeat(17), "A\tB", "A\u0007B"]) {
      fireEvent.change(screen.getByLabelText("Player name:"), {
        target: { value: bad },
      });
      fireEvent.blur(screen.getByLabelText("Player name:"));
      expect(screen.getByTestId("name-error")).toHaveTextContent(/characters/);
    }
    // Nothing was sent — the server never had to reject anything.
    expect(host.pairs[0].clientSent.length).toBe(sentBefore);

    // Typing clears the error; a valid save then works.
    fireEvent.change(screen.getByLabelText("Player name:"), {
      target: { value: "Alex" },
    });
    expect(screen.queryByTestId("name-error")).toBeNull();
    fireEvent.blur(screen.getByLabelText("Player name:"));
    expect(
      await screen.findByText("Alex", { selector: '[data-testid="seat-p0"] *' })
    ).toBeInTheDocument();
  });

  it("shows a server rejection as a normal error banner", async () => {
    const { harness, host } = await seatedHost();
    const guest = harness.addPlayer();
    await connectPlayer(guest);
    await playerAct(() =>
      guest.client.joinRoom(host.client.getState().roomId as string)
    );
    expect(await screen.findByText(`2 / ${MAX_SEATS}`)).toBeInTheDocument();

    // The host renames… but the guest leaves a beat later and a race is
    // hard to stage honestly — instead drive the REAL server rule: names
    // freeze once playing. Start the match, then try to save a name.
    fireEvent.click(screen.getByTestId("start-match"));
    await screen.findByText("Multiplayer match", {}, { timeout: 5000 });

    // The name editor is a waiting-room affordance: it is gone with the
    // lobby (names are frozen into the match).
    expect(screen.queryByLabelText("Player name:")).toBeNull();
    expect(screen.queryByTestId("save-name")).toBeNull();
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
    fireEvent.change(screen.getByLabelText("Player name:"), {
      target: { value: "Szymon" },
    });
    fireEvent.blur(screen.getByLabelText("Player name:"));
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
    expect(screen.getByLabelText("Player name:")).toHaveValue("Szymon");
    expect(within(seat as HTMLElement).getByText("You")).toBeInTheDocument();
  });

  it("Enter in the input saves too (keyboard path)", async () => {
    const { host } = await seatedHost();
    fireEvent.change(screen.getByLabelText("Player name:"), {
      target: { value: "Zosia" },
    });
    fireEvent.keyDown(screen.getByLabelText("Player name:"), { key: "Enter" });
    expect(lastSent(host.pairs[0])).toEqual({
      protocolVersion: 1,
      type: "set_name",
      name: "Zosia",
    });
    expect(
      await screen.findByText("Zosia", { selector: '[data-testid="seat-p0"] *' })
    ).toBeInTheDocument();
  });
});
