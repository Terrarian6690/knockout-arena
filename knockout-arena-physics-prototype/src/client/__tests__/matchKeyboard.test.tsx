// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../../game";
import { ControlPanel } from "../components/ControlPanel";
import { MatchControls } from "../components/game/MatchControls";

/**
 * MATCH KEYBOARD SHORTCUTS.
 *
 * Two hotkeys over the match controls, identical on the multiplayer
 * screen and in practice solo:
 *
 *   - digits 1..5 pick that POWER level;
 *   - SPACE presses CONFIRM (locks aim + power for the round).
 *
 * The shortcuts are a pure input bridge onto the same callbacks the
 * on-screen buttons use, and they exist ONLY while the player may act:
 * a confirmed/resolving/finished player's keyboard does nothing (no
 * stale commands), held-key auto-repeat fires once, modifier combos
 * (Ctrl/Meta/Alt+…) stay with the browser, and typing in a text field is
 * never hijacked. Space's default is suppressed, so a FOCUSED Confirm
 * button cannot double-fire — one press, exactly one command.
 */

afterEach(cleanup);

const type = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key, ...init });

describe("multiplayer MatchControls keyboard", () => {
  it("digits 1..5 pick that power level", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
      />
    );

    for (const level of [1, 2, 3, 4, 5]) {
      type(String(level));
    }
    expect(onPowerChange.mock.calls.map(([n]) => n)).toEqual([1, 2, 3, 4, 5]);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("digits outside the power range do nothing", () => {
    const onPowerChange = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={vi.fn()}
      />
    );

    type("0");
    type("6");
    type("9");
    // The engine's own range decides the guard (1..5 today).
    expect(CONFIG.power.min).toBe(1);
    expect(CONFIG.power.max).toBe(5);
    expect(onPowerChange).not.toHaveBeenCalled();
  });

  it("Space presses Confirm — once, even from a focused button", () => {
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={vi.fn()}
        onLaunch={onLaunch}
      />
    );

    // The Confirm button has focus (as after a Tab); Space must trigger
    // the confirm exactly once, not the native click PLUS the hotkey.
    const confirm = screen.getByTestId("launch");
    (confirm as HTMLButtonElement).focus();
    // fireEvent dispatches on `window` here, mirroring the real event
    // path (the handler is on window; the focused button is irrelevant
    // to routing). dispatchEvent returns false when preventDefault ran.
    const defaultAllowed = fireEvent.keyDown(window, { key: " ", cancelable: true });
    expect(onLaunch).toHaveBeenCalledTimes(1);
    // The default (native button activation / page scroll) was cancelled.
    expect(defaultAllowed).toBe(false);
  });

  it("numpad digits pick power too", () => {
    const onPowerChange = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={vi.fn()}
      />
    );
    fireEvent.keyDown(window, { key: "5", code: "Numpad5" });
    expect(onPowerChange).toHaveBeenCalledWith(5);
  });

  it("held-key auto-repeat fires once, not a stream", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
      />
    );
    type("4", { repeat: true });
    type(" ", { repeat: true });
    expect(onPowerChange).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("modifier combos (Ctrl/Meta/Alt) pass through untouched", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
      />
    );
    type("2", { ctrlKey: true });
    type(" ", { metaKey: true });
    type("3", { altKey: true });
    expect(onPowerChange).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("typing in a text field is never hijacked", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={true}
        lockedIn={false}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
      />
    );
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: "2" });
    fireEvent.keyDown(field, { key: " " });
    expect(onPowerChange).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
    field.remove();
  });

  it("a player who cannot act (confirmed/resolving) gets no hotkeys", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <MatchControls
        power={3}
        canAct={false}
        lockedIn={true}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
      />
    );
    type("2");
    type("5");
    type(" ");
    expect(onPowerChange).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });
});

describe("solo ControlPanel keyboard", () => {
  it("digits pick power and Space launches while aiming", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <ControlPanel
        phase="aiming"
        power={3}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
        onReset={vi.fn()}
      />
    );
    type("5");
    expect(onPowerChange).toHaveBeenCalledWith(5);
    type(" ");
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("outside the aiming phase the keyboard does nothing", () => {
    const onPowerChange = vi.fn();
    const onLaunch = vi.fn();
    render(
      <ControlPanel
        phase="moving"
        power={3}
        onPowerChange={onPowerChange}
        onLaunch={onLaunch}
        onReset={vi.fn()}
      />
    );
    type("2");
    type(" ");
    expect(onPowerChange).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });
});
