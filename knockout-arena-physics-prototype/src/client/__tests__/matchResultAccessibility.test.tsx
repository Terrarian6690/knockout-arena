// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, type PawnSnapshot } from "../../game";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import { MultiplayerGame } from "../components/game/MultiplayerGame";
import { NetworkProvider } from "../network/react";
import { createScriptedClient, wire } from "./lobbyTestHarness";

/**
 * MATCH RESULT ACCESSIBILITY (Task 9).
 *
 * The overlay's visible result is three separate fragments (emoji,
 * headline, detail). A screen reader needs one concise sentence, which
 * lives in a visually hidden polite live region.
 *
 * What these tests pin:
 *   - the region exists, is polite/atomic, and is announced AFTER mount
 *     (an already-populated region is unreliably announced);
 *   - the announcement names the authoritative winner, and reads
 *     sensibly when there is none;
 *   - re-renders of a finished match never change the text, so nothing
 *     is announced twice;
 *   - the announcement carries only PUBLIC result information — never a
 *     remote player's aim, power or readiness;
 *   - the existing visual presentation and keyboard behaviour are intact.
 */

const MAX = CONFIG.match.maxPlayers;

// The announcement is published on a post-mount timeout; fake timers let
// each test flush it deterministically instead of racing a real one.
beforeEach(() => {
  vi.useFakeTimers();
});

// No vitest globals in this project → unmount React trees by hand.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Flush the post-mount announcement effect. */
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

/** Render the overlay and flush the post-mount announcement effect. */
async function renderOverlay(props: {
  winnerId: string | null;
  localPawnId: string | null;
  pawns?: PawnSnapshot[];
  onLeave?: () => void;
}) {
  const view = render(
    <MatchResultOverlay
      winnerId={props.winnerId}
      localPawnId={props.localPawnId}
      pawns={props.pawns ?? sixPawns(5)}
      onLeave={props.onLeave ?? (() => {})}
    />
  );
  await flushAnnouncement();
  return view;
}

const liveRegion = () => screen.getByTestId("match-result-announcement");

describe("the match result is announced to assistive technology", () => {
  it("exposes a polite, atomic live region", async () => {
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const region = liveRegion();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveAttribute("role", "status");
    // Visually hidden, but still in the accessibility tree (sr-only
    // clips the box; it must never be display:none / aria-hidden).
    expect(region).toHaveClass("sr-only");
    expect(region).not.toHaveAttribute("aria-hidden");
  });

  it("fills the region AFTER mount, so the change is announced", () => {
    // Before the effect flushes the region exists but is empty: a live
    // region that arrives already populated is often not announced.
    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={() => {}}
      />
    );
    expect(liveRegion()).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent("");
  });

  it("names the winner when another player wins", async () => {
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const text = liveRegion().textContent ?? "";
    expect(text).toContain("Player 6");
    expect(text).toContain("wins the match");
    expect(text).toMatch(/knocked out/i);
  });

  it("announces the local player's own victory", async () => {
    await renderOverlay({ winnerId: "p0", localPawnId: "p0" });
    const text = liveRegion().textContent ?? "";
    expect(text).toMatch(/victory/i);
    expect(text).toMatch(/you win/i);
  });

  it("announces a no-winner result understandably", async () => {
    await renderOverlay({
      winnerId: null,
      localPawnId: "p0",
      pawns: sixPawns(null),
    });
    const text = liveRegion().textContent ?? "";
    expect(text).toMatch(/no survivor/i);
    // It must not imply somebody won, and must not read as an id.
    expect(text).not.toMatch(/wins the match/i);
    expect(text).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("uses a custom display name when the winner has one", async () => {
    const pawns = sixPawns(5).map((p, i) =>
      i === 5 ? { ...p, name: "Ada" } : p
    );
    await renderOverlay({ winnerId: "p5", localPawnId: "p0", pawns });
    expect(liveRegion()).toHaveTextContent("Ada wins the match.");
  });

  it("falls back to the seat id if the winner is not in the roster", async () => {
    // Defensive: the verdict is authoritative even if the pawn list is
    // somehow missing that seat — the announcement must still be useful.
    await renderOverlay({
      winnerId: "p5",
      localPawnId: "p0",
      pawns: sixPawns(5).slice(0, 3),
    });
    expect(liveRegion()).toHaveTextContent("p5 wins the match.");
  });

  it("is a single concise sentence group, not the whole overlay text", async () => {
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const spoken = liveRegion().textContent ?? "";
    // Short enough to be a useful announcement…
    expect(spoken.length).toBeLessThan(120);
    // …and it does not drag in the visible decorative copy.
    expect(spoken).not.toContain("Every rival pawn left the arena");
    expect(spoken).not.toContain("Back to lobby");
  });
});

describe("the announcement does not repeat on unrelated re-renders", () => {
  it("keeps identical text across re-renders with the same result", async () => {
    const view = await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const first = liveRegion().textContent;
    const node = liveRegion();

    // A finished match keeps re-rendering (further snapshots,
    // match_finished, connection changes). Re-render several times with
    // the same authoritative verdict.
    for (let i = 0; i < 3; i++) {
      view.rerender(
        <MatchResultOverlay
          winnerId="p5"
          localPawnId="p0"
          pawns={sixPawns(5)}
          onLeave={() => {}}
        />
      );
      await flushAnnouncement();
    }

    // Same live region node, same text → no new announcement.
    expect(liveRegion()).toBe(node);
    expect(liveRegion().textContent).toBe(first);
  });

  it("does not re-announce when unrelated props change", async () => {
    const view = await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const before = liveRegion().textContent;

    // Pawn positions keep arriving; the verdict is unchanged.
    view.rerender(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5).map((p) => ({
          ...p,
          position: { x: p.position.x + 25, y: p.position.y - 10 },
        }))}
        onLeave={() => {}}
      />
    );
    await flushAnnouncement();
    expect(liveRegion().textContent).toBe(before);
  });

  it("DOES update if the authoritative verdict itself changes", async () => {
    // Not expected mid-match, but the region must track the real result
    // rather than latching the first thing it saw.
    const view = await renderOverlay({
      winnerId: null,
      localPawnId: "p0",
      pawns: sixPawns(null),
    });
    expect(liveRegion()).toHaveTextContent(/no survivor/i);

    view.rerender(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={sixPawns(5)}
        onLeave={() => {}}
      />
    );
    await flushAnnouncement();
    expect(liveRegion()).toHaveTextContent("Player 6 wins the match.");
  });
});

describe("the announcement leaks nothing private", () => {
  it("says nothing about aim, power or readiness", async () => {
    // Every pawn carries a revealed launch (public post-resolution) and
    // the losers are confirmed — none of it belongs in the result.
    const pawns = sixPawns(5).map((p, i) => ({
      ...p,
      confirmed: i !== 5,
      launch: { direction: { x: 0.6, y: -0.8 }, power: 5 },
    }));
    await renderOverlay({ winnerId: "p5", localPawnId: "p0", pawns });
    const text = liveRegion().textContent ?? "";
    expect(text).not.toMatch(/power/i);
    expect(text).not.toMatch(/aim|direction|angle/i);
    expect(text).not.toMatch(/ready|confirmed/i);
    // The only digits allowed are the ones inside the winner's own
    // name ("Player 6"); nothing that could encode a power or a vector.
    const withoutWinnerName = text.replace("Player 6", "");
    expect(withoutWinnerName).not.toMatch(/\d/);
  });

  it("is identical whatever the other players secretly chose", async () => {
    const withChoices = (power: number, confirmed: boolean) =>
      sixPawns(5).map((p, i) =>
        i === 5 ? p : { ...p, confirmed, launch: { direction: { x: 1, y: 0 }, power } }
      );

    const a = await renderOverlay({
      winnerId: "p5",
      localPawnId: "p0",
      pawns: withChoices(1, false),
    });
    const first = liveRegion().textContent;
    a.unmount();

    await renderOverlay({
      winnerId: "p5",
      localPawnId: "p0",
      pawns: withChoices(5, true),
    });
    expect(liveRegion().textContent).toBe(first);
  });

  it("names only the winner, not the other five players", async () => {
    const pawns = sixPawns(5).map((p, i) => ({ ...p, name: `Secret${i}` }));
    await renderOverlay({ winnerId: "p5", localPawnId: "p0", pawns });
    const text = liveRegion().textContent ?? "";
    expect(text).toContain("Secret5");
    for (const other of ["Secret1", "Secret2", "Secret3", "Secret4"]) {
      expect(text).not.toContain(other);
    }
  });
});

describe("the existing overlay behaviour is unchanged", () => {
  it("keeps the visual winner presentation intact", async () => {
    await renderOverlay({ winnerId: "p0", localPawnId: "p0" });
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("Victory!");
    expect(result).toHaveTextContent("Every rival pawn left the arena.");
    expect(result).toHaveTextContent("🏆");
  });

  it("keeps the visual loser presentation intact", async () => {
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("Knocked Out!");
    expect(result).toHaveTextContent("Player 6 wins the match.");
  });

  it("keeps the no-survivor presentation intact", async () => {
    await renderOverlay({
      winnerId: null,
      localPawnId: "p0",
      pawns: sixPawns(null),
    });
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("No Survivor!");
    expect(result).toHaveTextContent("Every pawn left the arena — total knockout!");
  });

  it("does not duplicate the visible text into the visible overlay", async () => {
    // The hidden sentence must live OUTSIDE the visible card, so sighted
    // users never see it doubled.
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    const card = screen.getByTestId("match-result");
    expect(card).not.toContainElement(liveRegion());
    expect(card.textContent).not.toContain("Match over.");
  });

  it("keeps Back to lobby focusable and operable by keyboard", async () => {
    const onLeave = vi.fn();
    await renderOverlay({ winnerId: "p5", localPawnId: "p0", onLeave });
    const button = screen.getByTestId("back-to-lobby");

    // Reachable: a real button, focusable, not hidden behind the
    // pointer-events-none backdrop.
    button.focus();
    expect(button).toHaveFocus();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toBeEnabled();

    // Operable: keyboard activation fires the same handler.
    fireEvent.click(button);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("does not trap or steal focus when the result appears", async () => {
    // The overlay is informational; it must not yank focus away.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await renderOverlay({ winnerId: "p5", localPawnId: "p0" });
    expect(outside).toHaveFocus();
    outside.remove();
  });
});

// ── end-of-match states, through the real game screen ────────────────────

describe("the announcement covers every end-of-match state", () => {
  /** Render the real game screen over scripted sockets. */
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

  it("announces a normal single-survivor win", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: "p1" }, { p0: { isLocal: true } });
    expect(liveRegion()).toHaveTextContent("Player 2 wins the match.");
  });

  it("announces a six-player match result", async () => {
    const { sockets } = await renderGame();
    const six = Array.from({ length: MAX }, (_, i) => ({
      id: `p${i}`,
      isLocal: i === 0,
      eliminated: i !== 5,
      colorIndex: i,
    }));
    await feed(sockets, { phase: "finished", winnerId: "p5", pawns: six });
    expect(liveRegion()).toHaveTextContent("Player 6 wins the match.");
    // The five losers are not named in the announcement.
    expect(liveRegion().textContent).not.toContain("Player 3");
  });

  it("announces a timeout winner exactly as the server supplied it", async () => {
    // A match ended by the 4-minute limit: the survivor nearest the
    // centre wins by the existing authoritative tie-break. The client
    // invents nothing — it reads winnerId.
    const { sockets } = await renderGame();
    const pawns = Array.from({ length: MAX }, (_, i) => ({
      id: `p${i}`,
      isLocal: i === 0,
      eliminated: false, // several alive: the limit, not eliminations
      colorIndex: i,
    }));
    await feed(sockets, { phase: "finished", winnerId: "p3", pawns });
    expect(liveRegion()).toHaveTextContent("Player 4 wins the match.");
    expect(screen.getByTestId("match-result")).toHaveTextContent("Knocked Out!");
  });

  it("announces a zero-survivor timeout (winner null)", async () => {
    const { sockets } = await renderGame();
    const pawns = Array.from({ length: MAX }, (_, i) => ({
      id: `p${i}`,
      isLocal: i === 0,
      eliminated: true,
      colorIndex: i,
    }));
    await feed(sockets, { phase: "finished", winnerId: null, pawns });
    expect(liveRegion()).toHaveTextContent(/no survivor/i);
    expect(screen.getByTestId("match-result")).toHaveTextContent("No Survivor!");
  });

  it("announces once when arriving at an ALREADY finished match", async () => {
    // Reconnecting into a finished match: the first snapshot this client
    // ever sees is the result. It must still be announced.
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "finished", winnerId: "p1" }, { p0: { isLocal: true } });
    const announced = liveRegion().textContent;
    expect(announced).toContain("Player 2 wins the match.");

    // The server keeps pushing the finished state; nothing changes.
    await feed(sockets, { phase: "finished", winnerId: "p1" }, { p0: { isLocal: true } });
    await feed(sockets, { phase: "finished", winnerId: "p1" }, { p0: { isLocal: true } });
    expect(liveRegion().textContent).toBe(announced);
  });

  it("stays silent while the match is still running", async () => {
    const { sockets } = await renderGame();
    await feed(sockets, { phase: "aiming" }, { p0: { isLocal: true } });
    // No overlay, so no live region at all — nothing to announce yet.
    expect(screen.queryByTestId("match-result")).toBeNull();
    expect(screen.queryByTestId("match-result-announcement")).toBeNull();
  });
});
