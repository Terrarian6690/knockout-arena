// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MatchControls } from "../components/game/MatchControls";

/**
 * The confirm control's LABEL contract (Task 20 a11y): every state a
 * player can sit in must read as words — never a bare "…" that assistive
 * tech announces as "dot dot dot". The three states:
 *   - canAct:            "Confirm launch" (enabled)
 *   - confirmed:         "Confirmed — waiting…" (disabled, locked choice)
 *   - everything else    "Waiting for round…" (disabled: round resolving,
 *                        eliminated-but-watching, or disconnected)
 */

afterEach(cleanup);

const noop = () => {};

describe("MatchControls confirm label", () => {
  it("an active player sees Confirm launch, enabled", () => {
    render(
      <MatchControls power={3} canAct={true} lockedIn={false} onPowerChange={noop} onLaunch={noop} />
    );
    const btn = screen.getByTestId("launch");
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent("Confirm launch");
    expect(btn).toHaveAccessibleName("Confirm launch");
  });

  it("a confirmed player sees the locked label, disabled", () => {
    render(
      <MatchControls power={3} canAct={false} lockedIn={true} onPowerChange={noop} onLaunch={noop} />
    );
    const btn = screen.getByTestId("launch");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Confirmed — waiting…");
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
