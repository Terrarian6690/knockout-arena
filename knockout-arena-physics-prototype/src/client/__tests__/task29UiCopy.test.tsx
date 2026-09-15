// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MatchControls } from "../components/game/MatchControls";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import type { PawnSnapshot } from "../../game/types";
import {
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * TASK 29 — four small UI/copy fixes, each pinned here.
 *
 *   1. a no-winner match reads as a DRAW, identically for every player,
 *      and the visible wording matches the Task 9 live-region sentence;
 *   2. the redundant "Level" caption is gone from the match controls,
 *      without touching the power selector's accessible names;
 *   3. the "waiting for another player" line is gone from PRIVATE rooms
 *      and unchanged in public ones;
 *   4. the two name-required hints use the design system's danger red.
 */

afterEach(cleanup);

// ── 1. the draw message ──────────────────────────────────────────────────

/** Six pawns, all eliminated — the zero-survivor end state. */
const drawnPawns = (): PawnSnapshot[] =>
  Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`,
    position: { x: i, y: 0 },
    radius: 1,
    alive: false,
    color: "#fff",
    name: `Player ${i + 1}`,
  })) as unknown as PawnSnapshot[];

async function renderResult(localPawnId: string | null) {
  const view = render(
    <MatchResultOverlay
      winnerId={null}
      localPawnId={localPawnId}
      pawns={drawnPawns()}
      onLeave={() => {}}
    />
  );
  // The live region publishes one commit after mount.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1));
  });
  return view;
}

describe("a drawn match reads the same to everybody", () => {
  it("shows identical text to every player", async () => {
    // The regression this guards: a per-viewer verdict, where one player
    // is told they won (or lost) a match that nobody won.
    const seen = new Set<string>();
    for (const me of ["p0", "p3", "p5", null]) {
      cleanup();
      await renderResult(me);
      seen.add(screen.getByTestId("match-result").textContent ?? "");
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toContain("Draw — No Survivors");
  });

  it("styles it identically too — nobody gets a winner's frame", async () => {
    const styles = new Set<string>();
    for (const me of ["p0", "p3", "p5"]) {
      cleanup();
      await renderResult(me);
      styles.add(screen.getByTestId("match-result").className);
    }
    expect(styles.size).toBe(1);
    const only = [...styles][0]!;
    // Neither the victory green nor the personal-defeat red.
    expect(only).not.toContain("border-emerald-400/30");
    expect(only).not.toContain("border-red-400/30");
  });

  it("names the outcome a draw rather than implying a defeat", async () => {
    await renderResult("p0");
    const card = screen.getByTestId("match-result");

    expect(card).toHaveTextContent("Draw — No Survivors");
    // The old title implied only absence; these are win/lose words that
    // must not appear on a drawn result.
    expect(card).not.toHaveTextContent(/victory/i);
    expect(card).not.toHaveTextContent(/knocked out/i);
  });

  it("the visible detail matches the announced sentence", async () => {
    // Task 9's live region and the sighted card must agree; they used to
    // say "total knockout!" and "no survivor — every pawn left the
    // arena." respectively.
    await renderResult("p0");
    const announced = screen.getByTestId("match-result-announcement");
    const card = screen.getByTestId("match-result");

    expect(announced).toHaveTextContent(
      "Match over. No survivor — every pawn left the arena."
    );
    expect(card).toHaveTextContent("No survivor — every pawn left the arena.");
  });

  it("still announces exactly once, through the existing live region", async () => {
    await renderResult("p0");
    const region = screen.getByTestId("match-result-announcement");

    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    // The announcement lives outside the visible card (Task 9), so the
    // sentence is not doubled for sighted users.
    expect(screen.getByTestId("match-result")).not.toContainElement(region);
  });
});

// ── 2. the "Level" caption ───────────────────────────────────────────────

describe("the match controls lost the redundant Level caption", () => {
  const renderControls = (canAct = true) =>
    render(
      <MatchControls
        power={3}
        canAct={canAct}
        lockedIn={false}
        onPowerChange={() => {}}
        onLaunch={() => {}}
      />
    );

  it("does not render the word Level anywhere", () => {
    renderControls();
    expect(screen.getByTestId("match-controls").textContent).not.toMatch(
      /level/i
    );
  });

  it("still shows the current power value", () => {
    // Removing the caption must not remove the readout it captioned.
    renderControls();
    expect(screen.getByTestId("power-readout")).toHaveTextContent("3");
  });

  it("keeps the power selector's accessible names intact", () => {
    // The caption was never the accessible name — this is what is:
    // Task 21's role=group + per-button labels, unchanged.
    renderControls();
    expect(screen.getByRole("group", { name: "Power" })).toBeInTheDocument();
    for (const level of [1, 2, 3, 4, 5]) {
      expect(
        screen.getByRole("button", { name: `Power ${level}` })
      ).toBeInTheDocument();
    }
  });

  it("keeps the Confirm button working exactly as before", () => {
    let launched = 0;
    render(
      <MatchControls
        power={3}
        canAct
        lockedIn={false}
        onPowerChange={() => {}}
        onLaunch={() => {
          launched += 1;
        }}
      />
    );

    fireEvent.click(screen.getByTestId("launch"));

    expect(launched).toBe(1);
  });
});

// ── 3. the private-room waiting line ─────────────────────────────────────

describe("the waiting sentence is public-only now", () => {
  it("a private room shows none", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);

    await act(async () => {
      player.client.createRoom();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.queryByTestId("waiting-for-players")).toBeNull();
    expect(screen.getByTestId("room-panel").textContent).not.toMatch(
      /waiting for another player/i
    );
    // What conveys the wait instead: the disabled start control.
    expect(screen.getByTestId("start-match")).toBeDisabled();
  });

  it("a public room keeps it, unchanged", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);

    await act(async () => {
      player.client.joinPublicRoom();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.getByTestId("waiting-for-players")).toHaveTextContent(
      /waiting for another player to join/i
    );
    expect(screen.getByTestId("public-waiting-hint")).toBeInTheDocument();
  });
});

// ── 4. the red required-name hints ───────────────────────────────────────

describe("the name requirement is styled as a requirement", () => {
  const renderHome = async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client, { playerName: "" });
    return player;
  };

  it("the (required) marker beside the label is red", async () => {
    await renderHome();
    const marker = screen.getByText("(required)");

    expect(marker.className).toContain("text-red-300");
    expect(marker.className).not.toContain("amber");
  });

  it("the 'Enter a name above to play' hint is red", async () => {
    await renderHome();
    const hint = screen.getByTestId("name-gate-hint");

    expect(hint).toHaveTextContent("Enter a name above to play.");
    expect(hint.className).toMatch(/text-red-300/);
    expect(hint.className).not.toContain("amber");
  });

  it("the gate itself still works — colour was the only change", async () => {
    // Task 20's rule is untouched: no name, no play, and the hint is
    // still what describes the blocked controls.
    const player = await renderHome();
    const quickPlay = screen.getByRole("button", { name: /quick play/i });

    expect(quickPlay).toHaveAttribute("aria-describedby", "name-gate-hint");
    await act(async () => {
      fireEvent.click(quickPlay);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(player.client.getState().roomId).toBeNull();
  });
});
