// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MatchControls } from "../components/game/MatchControls";
import {
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";

/**
 * TASK 31 — two small copy/layout fixes.
 *
 *   1. the numeric power readout ("3" over "/ 5") that sat between the
 *      power selector and Confirm is gone, without touching Task 21's
 *      accessibility contract;
 *   2. the player-name input carries a VISIBLE "Player name:" label to
 *      the left of the field, each still with exactly one accessible
 *      name.
 */

afterEach(cleanup);

// ── 1. the power description ─────────────────────────────────────────────

describe("the power description is gone from the control bar", () => {
  const renderControls = (power = 3, canAct = true) =>
    render(
      <MatchControls
        power={power}
        canAct={canAct}
        lockedIn={false}
        onPowerChange={() => {}}
        onLaunch={() => {}}
      />
    );

  it("renders no numeric readout element", () => {
    renderControls();
    expect(screen.queryByTestId("power-readout")).toBeNull();
  });

  it("drops the '/ 5' denominator text too", () => {
    renderControls();
    const text = screen.getByTestId("match-controls").textContent ?? "";
    expect(text).not.toMatch(/\/\s*5/);
    // …and the Task 29 caption is still absent.
    expect(text).not.toMatch(/level/i);
  });

  it("no longer states the power outside the selector", () => {
    // The bar's text, minus the selector's own digits, must not repeat
    // the current level anywhere.
    renderControls(3);
    const bar = screen.getByTestId("match-controls");
    const meter = screen.getByTestId("power-meter");
    const outside = (bar.textContent ?? "").replace(meter.textContent ?? "", "");
    expect(outside).not.toMatch(/3/);
  });

  it("keeps the selector as the visible statement of the level", () => {
    // Removing the readout must not make the choice invisible: the
    // pressed button carries its own digit.
    for (const level of [1, 3, 5]) {
      cleanup();
      renderControls(level);
      const selected = screen.getByTestId(`power-level-${level}`);
      expect(selected).toHaveAttribute("aria-pressed", "true");
      expect(selected).toHaveTextContent(String(level));
    }
  });

  it("leaves Task 21's accessibility contract untouched", () => {
    renderControls(4);
    // The group and its label.
    const group = screen.getByRole("group", { name: "Power" });
    expect(group).toBeInTheDocument();
    // Every button keeps its accessible name…
    for (const level of [1, 2, 3, 4, 5]) {
      expect(
        screen.getByRole("button", { name: `Power ${level}` })
      ).toBeInTheDocument();
    }
    // …and exactly one is pressed.
    const pressed = [1, 2, 3, 4, 5].filter(
      (n) =>
        screen.getByTestId(`power-level-${n}`).getAttribute("aria-pressed") ===
        "true"
    );
    expect(pressed).toEqual([4]);
  });

  it("still selects a power by click (logic untouched)", () => {
    let chosen: number | null = null;
    render(
      <MatchControls
        power={3}
        canAct
        lockedIn={false}
        onPowerChange={(p) => {
          chosen = p;
        }}
        onLaunch={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Power 5" }));
    expect(chosen).toBe(5);
  });

  it("still confirms (Confirm behaviour untouched)", () => {
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

// ── 2. the "Player name:" labels ─────────────────────────────────────────

/** The home screen, with the name box empty. */
async function renderHome() {
  const harness = createServerHarness();
  const player = harness.addPlayer();
  await connectPlayer(player);
  renderLobby(player.client, { playerName: "" });
  return player;
}

/** A seated player in a waiting room, where the rename box lives. */
async function renderInRoom() {
  const harness = createServerHarness();
  const player = harness.addPlayer();
  await connectPlayer(player);
  renderLobby(player.client);
  await act(async () => {
    player.client.createRoom();
    await new Promise((r) => setTimeout(r, 20));
  });
  return player;
}

describe("the home-screen name box is labelled", () => {
  it("renders a visible 'Player name:' label", async () => {
    await renderHome();
    const label = screen.getByText(/Player name:/);
    expect(label).toBeVisible();
    // A real <label>, not a decorative span.
    expect(label.tagName).toBe("LABEL");
    expect(label).not.toHaveClass("sr-only");
  });

  it("associates the label with the input", async () => {
    await renderHome();
    const input = screen.getByTestId("player-name-input");
    expect(screen.getByLabelText(/Player name:/)).toBe(input);
    expect(screen.getByText(/Player name:/)).toHaveAttribute(
      "for",
      input.getAttribute("id")
    );
  });

  it("sits to the LEFT of the field, not above it", async () => {
    await renderHome();
    const input = screen.getByTestId("player-name-input");
    const label = screen.getByText(/Player name:/);
    // Same flex row, label first.
    const row = label.parentElement!;
    expect(row).toBe(input.parentElement);
    expect(row.className).toContain("flex");
    expect(row.className).toContain("items-center");
    expect(
      label.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("has exactly one accessible name — no competing aria-label", async () => {
    await renderHome();
    const input = screen.getByTestId("player-name-input");
    expect(input).not.toHaveAttribute("aria-label");
    expect(input).not.toHaveAttribute("aria-labelledby");
    // The <label> is the single source, and the placeholder does not
    // override it.
    expect(input).toHaveAccessibleName(expect.stringContaining("Player name:"));
  });

  it("keeps the (required) marker and the Task 20 gate intact", async () => {
    const player = await renderHome();
    // The marker is now a RESPONSE to a refused attempt, not a standing
    // decoration, so it is absent until the gate actually fires.
    expect(screen.queryByText("(required)")).toBeNull();
    const quickPlay = screen.getByRole("button", { name: /quick play/i });
    await act(async () => {
      fireEvent.click(quickPlay);
      await new Promise((r) => setTimeout(r, 20));
    });
    // Still gated: no name, no room.
    expect(player.client.getState().roomId).toBeNull();
    // ...and now the label explains why the click did nothing.
    expect(screen.getByText("(required)")).toBeInTheDocument();
  });
});

describe("the waiting room has no rename box", () => {
  // Removed on request: the name is chosen on the home screen only, so
  // the seated view must not offer (or render) a rename editor.
  it("a seated player sees no name editor at all", async () => {
    await renderInRoom();
    expect(screen.queryByTestId("display-name-input")).toBeNull();
    expect(screen.queryByLabelText("Player name:")).toBeNull();
  });
});
