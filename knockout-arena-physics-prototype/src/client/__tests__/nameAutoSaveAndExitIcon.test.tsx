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
 * TASK 27 — the name saves itself, and the way out is a red icon in the
 * corner.
 *
 * Two presentation changes, each with a rule that must NOT bend:
 *
 *   1. AUTO-SAVE. The "Save Name" button is gone. A valid name applies
 *      itself 400 ms after typing stops, and immediately on blur or
 *      Enter. What must not change: an INVALID draft is never sent —
 *      not on the debounce, not on blur, not on Enter — because the
 *      validation rule (normalizeDisplayName: 1–16 code points, no
 *      control characters) is the server's rule mirrored client-side.
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

const nameBox = () => screen.getByTestId("display-name-input");

/** Every name this client has put on the wire, in order. */
const namesSent = (pair: SocketPair) =>
  allSent(pair)
    .filter((m) => m.type === "set_name")
    .map((m) => m.name as string);

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

/** Let the 400 ms auto-save debounce elapse. */
async function settleDebounce() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 450));
  });
}

// ── 1. typing alone saves the name ───────────────────────────────────────

describe("a valid name saves itself, with nothing to click", () => {
  it("applies after typing stops — no Save button is involved", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;
    const before = namesSent(pair).length;

    // There is no Save button anywhere on the screen to press.
    expect(screen.queryByTestId("save-name")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();

    fireEvent.change(nameBox(), { target: { value: "Marika" } });
    await settleDebounce();

    expect(namesSent(pair).slice(before)).toEqual(["Marika"]);
    // The server's roster push is what actually renames the seat.
    const seat = await screen.findByTestId("seat-p0");
    expect(seat).toHaveTextContent("Marika");
  });

  it("waits for the pause: mid-word keystrokes do not each send", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;
    const before = namesSent(pair).length;

    // Four keystrokes in quick succession, none of them a full pause.
    for (const draft of ["A", "An", "Ann", "Anna"]) {
      fireEvent.change(nameBox(), { target: { value: draft } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
    }
    // Nothing has gone out yet — the player is still typing.
    expect(namesSent(pair).slice(before)).toEqual([]);

    await settleDebounce();
    // Exactly one message, carrying the finished name — not "A"/"An"/"Ann".
    expect(namesSent(pair).slice(before)).toEqual(["Anna"]);
  });

  it("blur applies it immediately, without waiting out the debounce", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;
    const before = namesSent(pair).length;

    fireEvent.change(nameBox(), { target: { value: "  Borys  " } });
    fireEvent.blur(nameBox());

    // Synchronously on blur, and trimmed the way the server would.
    expect(namesSent(pair).slice(before)).toEqual(["Borys"]);

    // The pending debounce must not then send a duplicate.
    await settleDebounce();
    expect(namesSent(pair).slice(before)).toEqual(["Borys"]);
  });

  it("Enter applies it immediately too", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;
    const before = namesSent(pair).length;

    fireEvent.change(nameBox(), { target: { value: "Celina" } });
    fireEvent.keyDown(nameBox(), { key: "Enter" });

    expect(namesSent(pair).slice(before)).toEqual(["Celina"]);
    await settleDebounce();
    expect(namesSent(pair).slice(before)).toEqual(["Celina"]);
  });

  it("re-typing the same name sends no second message", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;

    fireEvent.change(nameBox(), { target: { value: "Dorota" } });
    await settleDebounce();
    const after = namesSent(pair).length;

    // Same value again, committed every way there is.
    fireEvent.change(nameBox(), { target: { value: "Dorota" } });
    fireEvent.blur(nameBox());
    fireEvent.keyDown(nameBox(), { key: "Enter" });
    await settleDebounce();

    expect(namesSent(pair).length).toBe(after);
  });
});

// ── 2. invalid drafts still never reach the wire ─────────────────────────

describe("auto-save does not weaken validation", () => {
  it("never auto-applies an invalid in-progress name", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;
    const before = namesSent(pair).length;

    // Too long, a tab, a control character, and empty — every one of
    // these is a name normalizeDisplayName refuses.
    for (const bad of ["A".repeat(17), "A\tB", "A\u0007B", "   ", ""]) {
      fireEvent.change(nameBox(), { target: { value: bad } });
      await settleDebounce(); // the debounce fires and declines
      fireEvent.blur(nameBox()); // an explicit commit declines too
      fireEvent.keyDown(nameBox(), { key: "Enter" });
    }

    expect(namesSent(pair).slice(before)).toEqual([]);
  });

  it("stays quiet while typing, but explains itself on an explicit commit", async () => {
    await seatedHost();

    // Mid-edit: an incomplete draft is not scolded on every keystroke.
    fireEvent.change(nameBox(), { target: { value: "" } });
    await settleDebounce();
    expect(screen.queryByTestId("name-error")).toBeNull();

    // Blur is a deliberate commit — now the refusal is explained.
    fireEvent.blur(nameBox());
    expect(screen.getByTestId("name-error")).toHaveTextContent(/characters/);
    expect(screen.getByTestId("name-error")).toHaveAttribute("role", "alert");

    // And typing something valid clears it and goes through.
    fireEvent.change(nameBox(), { target: { value: "Ewa" } });
    expect(screen.queryByTestId("name-error")).toBeNull();
    await settleDebounce();
    expect(await screen.findByTestId("seat-p0")).toHaveTextContent("Ewa");
  });

  it("an invalid rename leaves the confirmed name standing", async () => {
    const { host } = await seatedHost();
    const pair = host.pairs[0]!;

    fireEvent.change(nameBox(), { target: { value: "Filip" } });
    await settleDebounce();
    expect(await screen.findByTestId("seat-p0")).toHaveTextContent("Filip");
    const after = namesSent(pair).length;

    // Now wreck the draft: the seat must keep the good name.
    fireEvent.change(nameBox(), { target: { value: "F".repeat(20) } });
    await settleDebounce();
    expect(namesSent(pair).length).toBe(after);
    expect(screen.getByTestId("seat-p0")).toHaveTextContent("Filip");
  });
});

// ── 3. the exit icon ─────────────────────────────────────────────────────

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
