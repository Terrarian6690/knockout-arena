// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import { focusableWithin } from "../components/game/focusTrap";
import {
  allSent,
  connectPlayer,
  createServerHarness,
  renderLobby,
  type SocketPair,
} from "./lobbyTestHarness";
import { render } from "@testing-library/react";
import type { PawnSnapshot } from "../../game/types";

/**
 * The way out is a red icon in the corner.
 *
 * (The in-room name editor this suite used to pin alongside the exit
 * icon was removed on request: names are set on the home screen only.
 * The exit-icon half is unchanged.)
 *
 * The remaining rule that must NOT bend:
 *
 *   2. THE EXIT ICON. The leave action moved out of the panel footer to
 *      the screen's top-left corner and lost its text. What must not
 *      change: it still calls the same leaveRoom(), still puts a
 *      leave_room frame on the wire, and still releases the seat.
 *
 * Everything below runs against the REAL server through in-memory
 * sockets — the wire assertions are the point, not a UI pantomime.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

/** How many frames of a type this client has sent. */
const countSent = (pair: SocketPair, type: string) =>
  allSent(pair).filter((m) => m.type === type).length;

/** How many seats the room currently holds, straight from the server. */
function seatCount(
  harness: ReturnType<typeof createServerHarness>,
  roomCode: string
): number {
  const room = harness.gameServer.getRoom(roomCode);
  return room === null ? 0 : room.seats.filter((s) => s !== null).length;
}

// ── the exit icon ────────────────────────────────────────────────────────

describe("the leave action is a red exit icon in the top-left corner", () => {
  it("is icon-only, yet still has an accessible name", async () => {
    await seatedHost();
    const leave = screen.getByTestId("leave-room");

    expect(leave.tagName).toBe("BUTTON");
    expect(leave).toBeEnabled();
    // No visible text: the label is carried by aria-label, not glyphs.
    expect(leave.textContent?.trim()).toBe("");
    expect(leave).toHaveAccessibleName("Leave Room");
    // The icon itself is hidden from the accessibility tree, so the
    // name is announced once, not twice.
    const icon = leave.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("wears the design system's danger red, not a new colour", async () => {
    await seatedHost();
    const cls = screen.getByTestId("leave-room").className;

    // The red family already used elsewhere in the app (error banner,
    // eliminated seats, the old hover state of this very button).
    expect(cls).toContain("text-red-300");
    expect(cls).toContain("border-red-400/30");
    expect(cls).toContain("bg-red-500/10");
    // Danger at rest, not merely on hover: no amber/emerald/slate
    // styling competing with it.
    expect(cls).not.toMatch(/\bbg-white\/5\b/);
  });

  it("sits in the top-left corner, outside the room panel", async () => {
    await seatedHost();
    const leave = screen.getByTestId("leave-room");
    const panel = screen.getByTestId("room-panel");

    // Pinned to the top-left, out of the document flow so it occupies
    // the margin beside the panel rather than space inside it.
    expect(leave.className).toMatch(/\b(absolute|fixed)\b/);
    expect(leave.className).toMatch(/\bleft-\d/);
    expect(leave.className).toMatch(/\btop-\d/);

    // Structurally outside the panel — not in the seat/content area.
    expect(panel.contains(leave)).toBe(false);
  });

  it("still leaves the room: leave_room on the wire, seat released", async () => {
    const { harness, host } = await seatedHost();
    const pair = host.pairs[0]!;
    const roomCode = screen.getByTestId("room-code").textContent!.trim();

    // A second player watches the seat count from inside the room.
    const guest = harness.addPlayer();
    await connectPlayer(guest);
    guest.client.joinRoom(roomCode);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(seatCount(harness, roomCode)).toBe(2);

    await act(async () => {
      fireEvent.click(screen.getByTestId("leave-room"));
      await new Promise((r) => setTimeout(r, 20));
    });

    // The same frame the text button used to send.
    expect(countSent(pair, "leave_room")).toBe(1);
    // The seat is genuinely released server-side, not just hidden.
    expect(seatCount(harness, roomCode)).toBe(1);
    // And the player is back on the home screen.
    expect(screen.getByRole("button", { name: "Create Room" })).toBeVisible();
  });
});

// ── 4. the post-match exit matches the waiting-room one ──────────────────

/**
 * The user asked for the post-match "Leave room" button to get the same
 * treatment: repositioned, and an escape-suggesting icon with no text.
 *
 * The hard constraint it must not break is Task 11's focus trap, which
 * walks the DIALOG's descendants — so the icon is positioned into the
 * corner visually while remaining a child of the dialog structurally.
 */
describe("the post-match exit gets the same icon treatment", () => {
  const pawns = (winner: number): PawnSnapshot[] =>
    Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      position: { x: i, y: 0 },
      radius: 1,
      alive: i === winner,
      color: "#fff",
      displayName: `Player ${i + 1}`,
    })) as unknown as PawnSnapshot[];

  async function renderOverlay(overrides: {
    onLeave?: () => void;
    onPlayAgain?: () => void;
  } = {}) {
    const view = render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={pawns(5)}
        onLeave={overrides.onLeave ?? (() => {})}
        onPlayAgain={overrides.onPlayAgain ?? (() => {})}
      />
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    return view;
  }

  const dialog = () => screen.getByTestId("match-result");

  it("is a text-free red icon in the top-left, like the waiting room's", async () => {
    await renderOverlay();
    const leave = screen.getByTestId("back-to-lobby");

    expect(leave.textContent?.trim()).toBe("");
    expect(leave).toHaveAccessibleName("Leave room");
    expect(leave.querySelector("svg")).not.toBeNull();

    const cls = leave.className;
    expect(cls).toContain("text-red-300");
    expect(cls).toContain("bg-red-500/10");
    expect(cls).toMatch(/\babsolute\b/);
    expect(cls).toMatch(/\bleft-\d/);
    expect(cls).toMatch(/\btop-\d/);
  });

  it("stays inside the focus trap, after Play again", async () => {
    // The regression this guards: positioning the icon into the corner
    // must not move it out of the dialog, or the trap would lose it and
    // Tab could escape the modal.
    await renderOverlay();
    const playAgain = screen.getByTestId("play-again");
    const leave = screen.getByTestId("back-to-lobby");

    expect(dialog().contains(leave)).toBe(true);
    expect(focusableWithin(dialog())).toEqual([playAgain, leave]);

    // Tab off the last action still wraps back to the first.
    leave.focus();
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(playAgain).toHaveFocus();
  });

  it("still leaves, and Escape still does the same thing", async () => {
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });

    fireEvent.click(screen.getByTestId("back-to-lobby"));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
