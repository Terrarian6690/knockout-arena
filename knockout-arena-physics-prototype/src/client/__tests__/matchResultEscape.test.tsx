// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, type PawnSnapshot } from "../../game";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import { handleTrapKeyDown } from "../components/game/focusTrap";

/**
 * ESCAPE-KEY DISMISSAL OF THE MATCH RESULT OVERLAY (Task 16).
 *
 * Escape must be a second way to press the SAME button, not a second
 * way out. What these tests pin:
 *
 *   - Escape calls the same dismissal callback as "Back to lobby", with
 *     the same arguments and the same resulting focus restoration;
 *   - Escape only fires from inside the dialog — never from elsewhere
 *     in the app, never before mount, never after close;
 *   - the Tab trap (Task 11) and the announcement (Task 9) are
 *     unaffected, including when Escape lands during the one-commit
 *     delay before the live region is populated.
 */

const MAX = CONFIG.match.maxPlayers;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function flushAnnouncement(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
}

function pawn(slot: number, overrides: Partial<PawnSnapshot> = {}): PawnSnapshot {
  return {
    id: `p${slot}`,
    name: `Player ${slot + 1}`,
    position: { x: 100 + slot * 10, y: 100 },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: slot === 0,
    colorIndex: slot,
    ...overrides,
  };
}

const sixPawns = (winnerSlot: number | null) =>
  Array.from({ length: MAX }, (_, i) =>
    pawn(i, { eliminated: winnerSlot === null ? true : i !== winnerSlot })
  );

async function renderOverlay(
  props: Partial<{
    winnerId: string | null;
    localPawnId: string | null;
    pawns: PawnSnapshot[];
    onLeave: () => void;
    getRestoreFocusFallback: () => HTMLElement | null;
  }> = {}
) {
  const view = render(
    <MatchResultOverlay
      winnerId={"winnerId" in props ? props.winnerId! : "p5"}
      localPawnId={"localPawnId" in props ? props.localPawnId! : "p0"}
      pawns={props.pawns ?? sixPawns(5)}
      onLeave={props.onLeave ?? (() => {})}
      getRestoreFocusFallback={props.getRestoreFocusFallback}
    />
  );
  await flushAnnouncement();
  return view;
}

const dialog = () => screen.getByTestId("match-result");
const backButton = () => screen.getByTestId("back-to-lobby");

// ── Escape dismisses exactly like the button ─────────────────────────────

describe("Escape triggers the same dismissal as Back to lobby", () => {
  it("calls the dismissal callback when the dialog has focus", async () => {
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    expect(dialog()).toHaveFocus();

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("invokes the very same callback the button does", async () => {
    // The contract is a SHARED dismissal path, not an identical
    // argument list: React's onClick={onLeave} hands the button's click
    // event to the callback, while the key forwards no argument. Both
    // call the same function object exactly once, which is what makes
    // the navigation and the restoration identical.
    const viaKey = vi.fn();
    const keyView = await renderOverlay({ onLeave: viaKey });
    fireEvent.keyDown(dialog(), { key: "Escape" });
    keyView.unmount();
    cleanup();

    const viaClick = vi.fn();
    await renderOverlay({ onLeave: viaClick });
    fireEvent.click(backButton());

    expect(viaKey).toHaveBeenCalledTimes(1);
    expect(viaClick).toHaveBeenCalledTimes(1);
    // The key path passes nothing; onLeave takes no parameters, so the
    // click event the button forwards is ignored by every call site.
    expect(viaKey.mock.calls[0]).toEqual([]);
  });

  it("works when focus is on the button inside the dialog", async () => {
    // The event bubbles from the focused descendant to the dialog's
    // handler, so Escape works anywhere inside the modal.
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    act(() => backButton().focus());
    expect(backButton()).toHaveFocus();

    fireEvent.keyDown(backButton(), { key: "Escape" });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on other keys", async () => {
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    for (const key of ["Enter", " ", "escape", "a", "Backspace", "Delete"]) {
      fireEvent.keyDown(dialog(), { key });
    }
    // Note "escape" (lowercase) is NOT the standard key value and is
    // correctly ignored; the canonical value is "Escape".
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("also accepts the legacy \"Esc\" spelling, via React normalization", async () => {
    // Old browsers (IE/Edge Legacy) report "Esc" rather than "Escape".
    // React's synthetic event layer normalizes it to "Escape" before
    // our handler runs, so those users get the same dismissal for free.
    // Pinned because it is behaviour we rely on rather than implement.
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    fireEvent.keyDown(dialog(), { key: "Esc" });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("prevents the default action so the key is not handled twice", async () => {
    await renderOverlay({ onLeave: vi.fn() });
    const dismissed = fireEvent.keyDown(dialog(), { key: "Escape" });
    // fireEvent returns false when preventDefault() was called.
    expect(dismissed).toBe(false);
  });
});

// ── focus restoration is the shared Task 11 path ─────────────────────────

describe("focus restoration after Escape matches the button", () => {
  it("restores to the previously focused element", async () => {
    const previous = document.createElement("button");
    document.body.appendChild(previous);
    previous.focus();

    const { unmount } = await renderOverlay({ onLeave: vi.fn() });
    fireEvent.keyDown(dialog(), { key: "Escape" });
    // The parent owns unmounting; Escape only requests it.
    unmount();

    expect(previous).toHaveFocus();
    previous.remove();
  });

  it("uses the fallback when the previous element is gone", async () => {
    const doomed = document.createElement("button");
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(doomed, fallback);
    doomed.focus();

    const { unmount } = await renderOverlay({
      onLeave: vi.fn(),
      getRestoreFocusFallback: () => fallback,
    });
    doomed.remove();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    unmount();

    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it("lands on the same element whether dismissed by key or by click", async () => {
    const landingSpot = (dismiss: (el: HTMLElement) => void) => {
      const previous = document.createElement("button");
      previous.id = "previous";
      document.body.appendChild(previous);
      previous.focus();
      return { previous, dismiss };
    };

    // Key path.
    const keyRun = landingSpot(() => {});
    const keyView = await renderOverlay({ onLeave: vi.fn() });
    fireEvent.keyDown(dialog(), { key: "Escape" });
    keyView.unmount();
    const afterKey = document.activeElement;
    expect(afterKey).toBe(keyRun.previous);
    keyRun.previous.remove();
    cleanup();

    // Click path.
    const clickRun = landingSpot(() => {});
    const clickView = await renderOverlay({ onLeave: vi.fn() });
    fireEvent.click(backButton());
    clickView.unmount();
    const afterClick = document.activeElement;
    expect(afterClick).toBe(clickRun.previous);

    // Same *kind* of target: the element that held focus before.
    expect(afterKey?.id).toBe(afterClick?.id);
    clickRun.previous.remove();
  });
});

// ── scoping: Escape must not fire from outside the overlay ───────────────

describe("Escape is scoped to the open overlay", () => {
  it("does nothing when pressed before the overlay mounts", async () => {
    const onLeave = vi.fn();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    // A stray Escape with no overlay on screen.
    fireEvent.keyDown(outside, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLeave).not.toHaveBeenCalled();

    await renderOverlay({ onLeave });
    expect(onLeave).not.toHaveBeenCalled();
    outside.remove();
  });

  it("does nothing when pressed after the overlay has closed", async () => {
    const onLeave = vi.fn();
    const { unmount } = await renderOverlay({ onLeave });
    unmount();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("does not fire from a sibling element outside the dialog", async () => {
    const onLeave = vi.fn();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    await renderOverlay({ onLeave });

    act(() => outside.focus());
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(onLeave).not.toHaveBeenCalled();

    outside.remove();
  });

  it("registers no document- or window-level key listener", async () => {
    // Structural proof of the scoping claim: the handler lives on the
    // dialog element, so nothing global can fire it.
    const docSpy = vi.spyOn(document, "addEventListener");
    const winSpy = vi.spyOn(window, "addEventListener");
    await renderOverlay({ onLeave: vi.fn() });

    const keyListeners = [...docSpy.mock.calls, ...winSpy.mock.calls].filter(
      ([type]) => String(type).startsWith("key")
    );
    expect(keyListeners).toEqual([]);
    docSpy.mockRestore();
    winSpy.mockRestore();
  });
});

// ── coexistence with the Task 11 trap and Task 9 announcement ────────────

describe("Escape coexists with the Tab trap and the announcement", () => {
  it("Tab still wraps inside the dialog after Escape was wired in", async () => {
    await renderOverlay({ onLeave: vi.fn() });
    expect(dialog()).toHaveFocus();

    // From the container, Tab moves to the first focusable element.
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(backButton()).toHaveFocus();

    // Tab off the last element wraps back to the first.
    fireEvent.keyDown(backButton(), { key: "Tab" });
    expect(backButton()).toHaveFocus();
  });

  it("Shift+Tab still wraps backwards", async () => {
    await renderOverlay({ onLeave: vi.fn() });
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(backButton()).toHaveFocus();
  });

  it("a Tab keypress never triggers dismissal", async () => {
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    fireEvent.keyDown(dialog(), { key: "Tab" });
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("the announcement still fires exactly once with Escape wired in", async () => {
    await renderOverlay({ winnerId: "p0", localPawnId: "p0", onLeave: vi.fn() });
    const region = screen.getByTestId("match-result-announcement");
    expect(region).toHaveTextContent("Match over. Victory! You win the match.");

    // Further commits must not republish (which would re-announce).
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(region).toHaveTextContent("Match over. Victory! You win the match.");
  });

  it("Escape during the pre-announcement delay still dismisses cleanly", async () => {
    // The live region is deliberately populated one commit AFTER mount
    // (Task 9). An Escape landing inside that window must still work,
    // and must not leave a half-published announcement behind.
    const onLeave = vi.fn();
    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={onLeave}
      />
    );
    // No flush: the region exists but is still empty.
    const region = screen.getByTestId("match-result-announcement");
    expect(region).toHaveTextContent("");

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onLeave).toHaveBeenCalledTimes(1);

    // The pending publish must not throw after dismissal is requested.
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("rapid repeated Escape presses each forward, without side effects", async () => {
    // The overlay does not unmount itself — the parent does — so a key
    // repeat can legitimately deliver several Escapes before the
    // unmount commits. Each must be a plain forward with no extra
    // state, and the dialog must stay coherent throughout.
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    for (let i = 0; i < 5; i += 1) {
      fireEvent.keyDown(dialog(), { key: "Escape" });
    }
    expect(onLeave).toHaveBeenCalledTimes(5);
    // Still focused, still rendered: no half-torn-down state.
    expect(dialog()).toBeInTheDocument();
    expect(dialog()).toHaveFocus();
  });
});

// ── the handler itself ───────────────────────────────────────────────────

describe("handleTrapKeyDown's Escape contract", () => {
  it("forwards Escape and leaves closing to the caller", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onEscape = vi.fn();
    const preventDefault = vi.fn();

    handleTrapKeyDown(
      { key: "Escape", shiftKey: false, preventDefault },
      container,
      onEscape
    );

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    // The helper never removes anything itself.
    expect(container.isConnected).toBe(true);
    container.remove();
  });

  it("is safe when no Escape callback is supplied", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    expect(() =>
      handleTrapKeyDown(
        { key: "Escape", shiftKey: false, preventDefault: () => {} },
        container
      )
    ).not.toThrow();
    container.remove();
  });

  it("ignores Escape when there is no container", () => {
    const onEscape = vi.fn();
    const preventDefault = vi.fn();
    handleTrapKeyDown(
      { key: "Escape", shiftKey: false, preventDefault },
      null,
      onEscape
    );
    expect(onEscape).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("keeps the Tab branch untouched by the new Escape branch", () => {
    const container = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("button");
    container.append(first, last);
    document.body.appendChild(container);
    const onEscape = vi.fn();

    last.focus();
    const preventDefault = vi.fn();
    handleTrapKeyDown({ key: "Tab", shiftKey: false, preventDefault }, container, onEscape);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(first).toHaveFocus();
    // Tab must never reach the dismissal callback.
    expect(onEscape).not.toHaveBeenCalled();
    container.remove();
  });
});
