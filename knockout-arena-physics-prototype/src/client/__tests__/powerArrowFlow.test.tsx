// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../../game";
// The speed helper is an engine internal (deliberately not on the public
// barrel the client consumes). Tests may read it directly to prove the
// physics numbers did not move; product code still must not.
import { launchSpeedFor } from "../../game/config";
import { MatchControls } from "../components/game/MatchControls";
import { PowerSelector } from "../components/PowerSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(cleanup);

const noop = () => {};

/**
 * The power arrow inside the real controls (Task 21).
 *
 * powerMeter.test.tsx pins the component in isolation; this pins it
 * WHERE IT IS USED — that the value chosen on the arrow is the value the
 * launch flow receives, that the rename is label-only, and that the same
 * control now serves the solo screen too.
 */

describe("the arrow drives the real launch flow", () => {
  it("hands each of the five levels to onPowerChange, unmodified", () => {
    const onPowerChange = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={noop}
      />
    );

    for (const level of [1, 2, 3, 4, 5]) {
      fireEvent.click(screen.getByRole("button", { name: `Power ${level}` }));
    }
    expect(onPowerChange.mock.calls.map(([p]) => p)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the selection in step with the current level", () => {
    // The numeric readout this used to check is gone (Task 31); the
    // selector itself still states the level, in the two ways that
    // matter — the pressed button and its visible digit.
    for (const level of [1, 2, 3, 4, 5]) {
      const view = render(
        <MatchControls
          power={level}
          canAct
          lockedIn={false}
          onPowerChange={noop}
          onLaunch={noop}
        />
      );
      const selected = screen.getByTestId(`power-level-${level}`);
      expect(selected).toHaveAttribute("aria-pressed", "true");
      expect(selected).toHaveTextContent(String(level));
      // Exactly one level is ever pressed.
      const pressed = [1, 2, 3, 4, 5].filter(
        (n) =>
          screen.getByTestId(`power-level-${n}`).getAttribute("aria-pressed") ===
          "true"
      );
      expect(pressed).toEqual([level]);
      view.unmount();
    }
  });

  it("selects by keyboard inside the real control bar", () => {
    const onPowerChange = vi.fn();
    render(
      <MatchControls
        power={2}
        canAct
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={noop}
      />
    );
    const second = screen.getByTestId("power-level-2");
    second.focus();
    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(onPowerChange).toHaveBeenCalledWith(3);
  });

  it("disables the arrow with the rest of the bar when the player cannot act", () => {
    render(
      <MatchControls
        power={4}
        canAct={false}
        lockedIn
        onPowerChange={noop}
        onLaunch={noop}
      />
    );
    for (const level of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`power-level-${level}`)).toBeDisabled();
    }
    // The locked choice stays readable.
    expect(screen.getByTestId("power-level-4")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});

describe("the Confirm button: renamed, not rewired", () => {
  it("reads Confirm and fires onLaunch once when enabled", () => {
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct
        lockedIn={false}
        onPowerChange={noop}
        onLaunch={onLaunch}
      />
    );
    const button = screen.getByTestId("launch");
    expect(button).toHaveTextContent("Confirm");
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("is still disabled and silent when the player cannot act", () => {
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={false}
        lockedIn={false}
        onPowerChange={noop}
        onLaunch={onLaunch}
      />
    );
    const button = screen.getByTestId("launch");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("keeps the other two state labels untouched", () => {
    const confirmed = render(
      <MatchControls
        power={3}
        canAct={false}
        lockedIn
        onPowerChange={noop}
        onLaunch={noop}
      />
    );
    expect(screen.getByTestId("launch")).toHaveTextContent(
      "Wait for the next game"
    );
    confirmed.unmount();

    render(
      <MatchControls
        power={3}
        canAct={false}
        lockedIn={false}
        onPowerChange={noop}
        onLaunch={noop}
      />
    );
    expect(screen.getByTestId("launch")).toHaveTextContent(
      "Waiting for round…"
    );
  });
});

describe("the solo practice screen shares the same control", () => {
  it("renders the arrow with the full accessibility contract", () => {
    render(<PowerSelector power={3} onChange={noop} />);
    // The solo selector previously had no role/aria-pressed at all.
    expect(screen.getByRole("group", { name: "Power" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Power [1-5]$/ })).toHaveLength(
      5
    );
    expect(screen.getByTestId("power-level-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByTestId("power-arrow")).toBeInTheDocument();
    // The wording that carries the scale for non-visual users stays.
    expect(screen.getByText("Weak")).toBeInTheDocument();
    expect(screen.getByText("Strong")).toBeInTheDocument();
  });

  it("selects and disables like the match-screen control", () => {
    const onChange = vi.fn();
    const view = render(<PowerSelector power={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Power 4" }));
    expect(onChange).toHaveBeenCalledWith(4);
    view.unmount();

    render(<PowerSelector power={1} onChange={onChange} disabled />);
    expect(screen.getByTestId("power-level-4")).toBeDisabled();
  });

  it("uses its own gradient id so two arrows can coexist", () => {
    render(
      <>
        <PowerSelector power={2} onChange={noop} />
        <MatchControls
          power={4}
          canAct
          lockedIn={false}
          onPowerChange={noop}
          onLaunch={noop}
        />
      </>
    );
    const ids = screen
      .getAllByTestId("power-arrow")
      .map((svg) => svg.querySelector("linearGradient")!.getAttribute("id"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // distinct: no shared <defs>
    // Each shape points at its OWN gradient.
    for (const shape of screen.getAllByTestId("power-arrow-shape")) {
      const id = shape
        .closest("svg")!
        .querySelector("linearGradient")!
        .getAttribute("id");
      expect(shape.getAttribute("fill")).toBe(`url(#${id})`);
    }
  });
});

describe("the underlying power values are untouched", () => {
  it("still maps the five levels to the same launch speeds", () => {
    // The redesign is visual: these are the numbers the physics uses and
    // they must not have moved.
    const speeds = [1, 2, 3, 4, 5].map((p) =>
      Number(launchSpeedFor(p).toFixed(4))
    );
    expect(speeds).toEqual([0.966, 2.7322, 5.0194, 7.7279, 10.8]);
  });

  it("still offers exactly the configured range", () => {
    expect(CONFIG.power.min).toBe(1);
    expect(CONFIG.power.max).toBe(5);
    render(<PowerSelector power={3} onChange={noop} />);
    expect(screen.getAllByRole("button", { name: /^Power \d+$/ })).toHaveLength(
      CONFIG.power.max - CONFIG.power.min + 1
    );
  });
});
