// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MatchControls } from "../components/game/MatchControls";

/**
 * The confirm control's LABEL contract (Task 20 a11y): every state a
 * player can sit in must read as words — never a bare "…" that assistive
 * tech announces as "dot dot dot". The three states:
 *   - canAct:            "Confirm" (enabled)
 *   - confirmed:         "Wait for the next game" (disabled, locked choice)
 *   - everything else    "Waiting for round…" (disabled: round resolving,
 *                        eliminated-but-watching, or disconnected)
 */

afterEach(cleanup);

const noop = () => {};

describe("MatchControls confirm label", () => {
  it("an active player sees Confirm, enabled", () => {
    render(
      <MatchControls power={3} canAct={true} lockedIn={false} onPowerChange={noop} onLaunch={noop} />
    );
    const btn = screen.getByTestId("launch");
    expect(btn).toBeEnabled();
    // Renamed from "Confirm launch" in Task 21 — label only; what the
    // button does and when it is enabled are unchanged.
    expect(btn).toHaveTextContent("Confirm");
    expect(btn).toHaveAccessibleName("Confirm");
    // Still reachable by role+name, which is how a screen-reader user
    // finds it.
    expect(screen.getByRole("button", { name: "Confirm" })).toBe(btn);
  });

  it("a confirmed player sees the locked label, disabled", () => {
    render(
      <MatchControls power={3} canAct={false} lockedIn={true} onPowerChange={noop} onLaunch={noop} />
    );
    const btn = screen.getByTestId("launch");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Wait for the next game");
  });

  it("passive states carry a meaningful label, never a bare ellipsis", () => {
    // Watching the round resolve / eliminated / disconnected — the control
    // must still say what is happening (regression: this used to be "…").
    render(
      <MatchControls power={3} canAct={false} lockedIn={false} onPowerChange={noop} onLaunch={noop} />
    );
    const btn = screen.getByTestId("launch");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Waiting for round…");
    expect(btn).not.toHaveTextContent(/^…$/);
    expect(btn).toHaveAccessibleName("Waiting for round…");
  });
});
