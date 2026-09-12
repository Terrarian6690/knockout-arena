// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, type PawnSnapshot } from "../../game";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { NetworkProvider } from "../network/react";
import {
  focusableWithin,
  handleTrapKeyDown,
  pickRestoreTarget,
} from "../components/game/focusTrap";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * MATCH RESULT FOCUS MANAGEMENT (Task 11).
 *
 * The overlay is a modal dialog: when a match ends, keyboard and screen
 * reader users must land ON the result instead of being left wherever
 * the (now unmounted) match controls used to be.
 *
 * What these tests pin:
 *   - focus moves into the dialog on mount, and onto the dialog itself
 *     so the result is read before the action button;
 *   - Tab and Shift+Tab wrap inside the dialog instead of escaping to
 *     the background game UI;
 *   - focus is restored on unmount — to the element that had it before
 *     the match ended when that element still exists, otherwise to a
 *     defined fallback, and never left stranded on <body>;
 *   - the Task 9 announcement still fires exactly once and on time,
 *     with focus management running alongside it.
 *
 * NOTE: Task 9's "does not trap or steal focus" expectation is
 * deliberately superseded here; see the renamed test in
 * matchResultAccessibility.test.tsx.
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

// ── initial focus ────────────────────────────────────────────────────────

describe("focus moves into the overlay when the match ends", () => {
  it("focuses the dialog container itself", async () => {
    await renderOverlay();
    expect(dialog()).toHaveFocus();
  });

  it("lands somewhere INSIDE the dialog, never on the body", async () => {
    await renderOverlay();
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("takes focus away from whatever held it before", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(outside).toHaveFocus();

    await renderOverlay();
    expect(outside).not.toHaveFocus();
    expect(dialog()).toHaveFocus();
  });

  it("is a programmatic focus target, not an extra Tab stop", async () => {
    // tabindex="-1": reachable by .focus(), skipped by sequential
    // navigation, so the dialog never becomes a phantom stop.
    await renderOverlay();
    expect(dialog()).toHaveAttribute("tabindex", "-1");
    expect(focusableWithin(dialog())).not.toContain(dialog());
  });

  it("exposes the result as a modal dialog naming the outcome", async () => {
    // Focusing the container is only useful if the container announces
    // the result; the headline labels it and the detail describes it.
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const el = dialog();
    expect(el).toHaveAttribute("role", "dialog");
    expect(el).toHaveAttribute("aria-modal", "true");
    expect(el).toHaveAccessibleName("Knocked Out!");
    expect(el).toHaveAccessibleDescription("Player 6 wins the match.");
  });

  it("focuses the winner's dialog too", async () => {
    await renderOverlay({ winnerId: "p0", localPawnId: "p0", pawns: sixPawns(0) });
    expect(dialog()).toHaveFocus();
    expect(dialog()).toHaveAccessibleName("Victory!");
  });

  it("focuses the no-survivor dialog too", async () => {
    await renderOverlay({ winnerId: null, localPawnId: "p0", pawns: sixPawns(null) });
    expect(dialog()).toHaveFocus();
    expect(dialog()).toHaveAccessibleName("No Survivor!");
  });

  it("does not re-steal focus on later re-renders", async () => {
    // A finished match keeps receiving snapshots. If the player has
    // tabbed to the button, a re-render must not yank them back.
    const view = await renderOverlay();
    const button = screen.getByTestId("back-to-lobby");
    button.focus();
    expect(button).toHaveFocus();

    view.rerender(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={() => {}}
      />
    );
    await flushAnnouncement();
    expect(button).toHaveFocus();
  });
});

// ── focus containment ────────────────────────────────────────────────────

describe("focus is contained while the overlay is open", () => {
  it("wraps Tab from the last focusable element back to the first", async () => {
    await renderOverlay();
    const items = focusableWithin(dialog());
    expect(items.length).toBeGreaterThan(0);

    const last = items[items.length - 1]!;
    last.focus();
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(items[0]!).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable element to the last", async () => {
    await renderOverlay();
    const items = focusableWithin(dialog());
    const first = items[0]!;
    first.focus();
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(items[items.length - 1]!).toHaveFocus();
  });

  it("pulls Tab from the dialog container onto the first element", async () => {
    // Initial focus sits on the container; the first Tab should enter
    // the dialog's controls rather than leaving for the background.
    await renderOverlay();
    expect(dialog()).toHaveFocus();
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(focusableWithin(dialog())[0]!).toHaveFocus();
  });

  it("sends Shift+Tab from the container to the LAST element", async () => {
    await renderOverlay();
    const items = focusableWithin(dialog());
    fireEvent.keyDown(dialog(), { key: "Tab", shiftKey: true });
    expect(items[items.length - 1]!).toHaveFocus();
  });

  it("leaves other keys alone", async () => {
    // Only Tab is intercepted — typing must not be swallowed.
    await renderOverlay();
    const button = screen.getByTestId("back-to-lobby");
    button.focus();
    for (const key of ["a", "Enter", " ", "ArrowRight", "Escape"]) {
      fireEvent.keyDown(dialog(), { key });
      expect(button).toHaveFocus();
    }
  });

  it("keeps Back to lobby operable while trapped", async () => {
    // Containment must not break the only way out.
    const onLeave = vi.fn();
    await renderOverlay({ onLeave });
    const button = screen.getByTestId("back-to-lobby");
    fireEvent.keyDown(dialog(), { key: "Tab" });
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("cannot reach background UI by tabbing", async () => {
    // The real risk: a button behind the modal receiving focus.
    const background = document.createElement("button");
    background.textContent = "background";
    document.body.appendChild(background);

    await renderOverlay();
    const items = focusableWithin(dialog());
    items[items.length - 1]!.focus();
    fireEvent.keyDown(dialog(), { key: "Tab" });

    expect(background).not.toHaveFocus();
    expect(dialog().contains(document.activeElement)).toBe(true);
    background.remove();
  });
});

// ── the trap helper in isolation ─────────────────────────────────────────

describe("focus trap helper", () => {
  function container(html: string): HTMLElement {
    const el = document.createElement("div");
    el.tabIndex = -1;
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it("ignores disabled and hidden controls", () => {
    const el = container(`
      <button id="a">a</button>
      <button id="b" disabled>b</button>
      <button id="c" aria-hidden="true">c</button>
      <button id="d" hidden>d</button>
      <button id="e" tabindex="-1">e</button>
      <button id="f">f</button>
    `);
    expect(focusableWithin(el).map((n) => n.id)).toEqual(["a", "f"]);
  });

  it("finds links, inputs and positive tabindex holders", () => {
    const el = container(`
      <a href="#x" id="link">x</a>
      <input id="field" />
      <div id="widget" tabindex="0"></div>
    `);
    expect(focusableWithin(el).map((n) => n.id)).toEqual([
      "link",
      "field",
      "widget",
    ]);
  });

  it("holds focus on the container when nothing inside is focusable", () => {
    const el = container("<p>nothing to focus</p>");
    el.focus();
    const prevented = vi.fn();
    handleTrapKeyDown({ key: "Tab", shiftKey: false, preventDefault: prevented }, el);
    expect(prevented).toHaveBeenCalled();
    expect(el).toHaveFocus();
  });

  it("does nothing without a container", () => {
    const prevented = vi.fn();
    expect(() =>
      handleTrapKeyDown({ key: "Tab", shiftKey: false, preventDefault: prevented }, null)
    ).not.toThrow();
    expect(prevented).not.toHaveBeenCalled();
  });

  it("does not intercept non-Tab keys", () => {
    const el = container('<button id="a">a</button>');
    const prevented = vi.fn();
    handleTrapKeyDown({ key: "Enter", shiftKey: false, preventDefault: prevented }, el);
    expect(prevented).not.toHaveBeenCalled();
  });

  it("lets Tab through between interior elements", () => {
    // Only the edges wrap; the browser handles the middle natively.
    const el = container('<button id="a">a</button><button id="b">b</button><button id="c">c</button>');
    (el.querySelector("#b") as HTMLElement).focus();
    const prevented = vi.fn();
    handleTrapKeyDown({ key: "Tab", shiftKey: false, preventDefault: prevented }, el);
    expect(prevented).not.toHaveBeenCalled();
  });

  it("prefers the previous element, then the fallback, then nothing", () => {
    const previous = document.createElement("button");
    const fallback = document.createElement("div");
    document.body.append(previous, fallback);

    expect(pickRestoreTarget(previous, fallback)).toBe(previous);

    // A detached previous element (its UI unmounted) falls through.
    previous.remove();
    expect(pickRestoreTarget(previous, fallback)).toBe(fallback);

    fallback.remove();
    expect(pickRestoreTarget(previous, fallback)).toBeNull();
    expect(pickRestoreTarget(null, null)).toBeNull();
  });
});

// ── focus restoration ────────────────────────────────────────────────────

describe("focus is restored when the overlay closes", () => {
  it("returns focus to the element that had it before the match ended", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();

    const view = await renderOverlay();
    expect(dialog()).toHaveFocus();

    await act(async () => {
      view.unmount();
    });
    expect(before).toHaveFocus();
    before.remove();
  });

  it("never leaves focus stranded on the body", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();

    const view = await renderOverlay();
    await act(async () => {
      view.unmount();
    });
    expect(document.activeElement).not.toBe(document.body);
    before.remove();
  });

  it("uses the fallback when the previous element is gone", async () => {
    // The realistic case: MatchControls unmounts when the match ends,
    // so the button that had focus no longer exists at dismissal.
    const doomed = document.createElement("button");
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(doomed, fallback);
    doomed.focus();

    const view = await renderOverlay({
      getRestoreFocusFallback: () => fallback,
    });
    doomed.remove(); // the match controls disappear

    await act(async () => {
      view.unmount();
    });
    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it("uses the fallback when nothing had focus at all", async () => {
    // Mouse-only player: focus sits on <body> when the match ends.
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.appendChild(fallback);
    expect(document.activeElement).toBe(document.body);

    const view = await renderOverlay({ getRestoreFocusFallback: () => fallback });
    await act(async () => {
      view.unmount();
    });
    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it("restores after dismissal by keyboard activation", async () => {
    // Dismissing via the button (Enter/Space → click) must restore too,
    // not just an external unmount.
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();

    let open = true;
    const view = render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={() => {
          open = false;
        }}
      />
    );
    await flushAnnouncement();

    fireEvent.keyDown(dialog(), { key: "Tab" });
    fireEvent.click(screen.getByTestId("back-to-lobby"));
    expect(open).toBe(false);

    await act(async () => {
      view.unmount(); // the app removes the overlay in response
    });
    expect(before).toHaveFocus();
    before.remove();
  });

  it("leaves focus alone if the user moved it outside the dialog", async () => {
    // Someone tabbed to browser UI or another region: reclaiming focus
    // on unmount would be hijacking it.
    const before = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(before, elsewhere);
    before.focus();

    const view = await renderOverlay();
    elsewhere.focus();

    await act(async () => {
      view.unmount();
    });
    expect(elsewhere).toHaveFocus();
    before.remove();
    elsewhere.remove();
  });

  it("survives a missing fallback without throwing", async () => {
    const view = await renderOverlay({ getRestoreFocusFallback: () => null });
    await act(async () => {
      expect(() => view.unmount()).not.toThrow();
    });
  });
});

// ── the announcement is unaffected (Task 9 regression) ───────────────────

describe("focus management does not disturb the Task 9 announcement", () => {
  const region = () => screen.getByTestId("match-result-announcement");

  it("still starts empty and fills one commit later", async () => {
    // The "start empty, populate later" sequencing is what makes the
    // region reliably announced; focus work must not short-circuit it.
    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={() => {}}
      />
    );
    expect(region()).toHaveTextContent("");

    await flushAnnouncement();
    expect(region()).toHaveTextContent(
      "Match over. You were knocked out. Player 6 wins the match."
    );
  });

  it("announces exactly once despite focus moving on mount", async () => {
    // A second announcement would mean the region's text changed twice.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(region().textContent ?? "");
    });

    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={() => {}}
      />
    );
    observer.observe(region(), {
      childList: true,
      characterData: true,
      subtree: true,
    });

    await flushAnnouncement();
    await flushAnnouncement();
    observer.disconnect();

    expect(dialog()).toHaveFocus(); // focus did move…
    expect(seen.filter((t) => t.includes("Match over."))).toHaveLength(1);
  });

  it("keeps the region polite, atomic and outside the dialog", async () => {
    // Inside the dialog it would be part of the focused element's
    // description and get read twice.
    await renderOverlay();
    const live = region();
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("aria-atomic", "true");
    expect(dialog()).not.toContainElement(live);
  });

  it("does not delay the announcement past its single timer tick", async () => {
    render(
      <MatchResultOverlay
        winnerId={null}
        localPawnId="p0"
        pawns={sixPawns(null)}
        onLeave={() => {}}
      />
    );
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(region()).toHaveTextContent(
      "Match over. No survivor — every pawn left the arena."
    );
  });

  it("announcement text is unchanged by the focus attributes", async () => {
    // The dialog's aria-labelledby/-describedby must not leak into the
    // spoken sentence, and the sentence must stay free of private data.
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const text = region().textContent ?? "";
    expect(text).toBe(
      "Match over. You were knocked out. Player 6 wins the match."
    );
    expect(text).not.toMatch(/power|aim|direction|ready|confirm/i);
  });
});

// ── through the real game screen ─────────────────────────────────────────

describe("focus management in the real game screen", () => {
  async function renderGame() {
    const { client, sockets } = createScriptedClient();
    render(
      <NetworkProvider client={client}>
        <MultiplayerGame onLeave={() => client.leaveRoom()} />
      </NetworkProvider>
    );
    await act(async () => {
      client.connect();
    });
    await act(async () => {
      sockets[0].serverOpen();
    });
    return { client, sockets };
  }

  async function feed(
    sockets: ReturnType<typeof createScriptedClient>["sockets"],
    overrides: Record<string, unknown> = {},
    pawnOverrides: Record<string, Record<string, unknown>> = {}
  ) {
    await act(async () => {
      sockets[0].serverMessage(wire.snapshot(overrides, pawnOverrides));
    });
    await flushAnnouncement();
  }

  it("focuses the result when a real match finishes", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "aiming" }, { p0: { isLocal: true } });
    expect(screen.queryByTestId("match-result")).toBeNull();

    await feed(sockets, { phase: "finished", winnerId: "p0" }, { p0: { isLocal: true } });
    expect(screen.getByTestId("match-result")).toHaveFocus();
  });

  it("restores focus to the arena region when the overlay goes away", async () => {
    // Back to an in-progress snapshot (e.g. a new match): the overlay
    // unmounts and focus must land on the arena, not the body.
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: "p0" }, { p0: { isLocal: true } });
    expect(screen.getByTestId("match-result")).toHaveFocus();

    await feed(sockets, { phase: "aiming", winnerId: null }, { p0: { isLocal: true } });
    expect(screen.queryByTestId("match-result")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.tagName).toBe("MAIN");
  });

  it("still announces the result in the real screen", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: "p0" }, { p0: { isLocal: true } });
    expect(screen.getByTestId("match-result-announcement")).toHaveTextContent(
      "Match over. Victory! You win the match."
    );
  });

  it("does not disturb focus while the match is still running", async () => {
    // Mid-match snapshots must never move focus — only the overlay does.
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "aiming" }, { p0: { isLocal: true } });
    const launch = screen.getByTestId("launch");
    launch.focus();

    await feed(sockets, { phase: "moving" }, { p0: { isLocal: true } });
    await feed(sockets, { phase: "aiming" }, { p0: { isLocal: true } });
    expect(launch).toHaveFocus();
  });
});
