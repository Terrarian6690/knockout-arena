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

describe("the control bar's height budget", () => {
  it("carries no captions on ANY screen — the desktop row too", () => {
    // The desktop bar got ~30px shorter by dropping the "Power" and
    // "Lock aim + power" captions everywhere: the meter announces
    // itself (aria-label "Power", per-button digits) and the button
    // states its own action, so the words were dead height.
    render(
      <MatchControls power={3} canAct={true} lockedIn={false} onPowerChange={noop} onLaunch={noop} />
    );
    const bar = screen.getByTestId("match-controls");
    expect(bar.textContent).not.toContain("Lock aim + power");
    const ownText = (bar.textContent ?? "").replace(
      screen.getByTestId("power-meter").textContent ?? "",
      ""
    );
    expect(ownText).not.toMatch(/power/i);
  });

  it("is a slim row on desktop too: 64px meter, py-2 padding", () => {
    render(
      <MatchControls power={3} canAct={true} lockedIn={false} onPowerChange={noop} onLaunch={noop} />
    );
    const bar = screen.getByTestId("match-controls");
    expect(bar.className).toContain("sm:py-2");
    const meter = screen.getByTestId("power-meter");
    expect(meter.className).toContain("sm:h-16");
    expect(meter.className).not.toContain("sm:h-[72px]");
    // Phones keep their own compact row untouched.
    expect(meter.className).toContain("h-14");
  });
});
