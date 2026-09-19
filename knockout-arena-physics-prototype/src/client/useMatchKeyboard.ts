import { useEffect } from "react";
import { CONFIG } from "../game";

/**
 * Match keyboard shortcuts — the hotkey half of the match controls.
 *
 *   - Digits 1..5 (top row or numpad) pick that power level;
 *   - Space presses CONFIRM (locks aim + power for the round).
 *
 * PURE INPUT BRIDGE: the hook only invokes the same callbacks the on-screen
 * controls use — the server (multiplayer) or the local engine (practice
 * solo) remains the sole authority over what the commands actually do.
 *
 * Discipline:
 *   - active=false (cannot act: confirmed, resolving, finished) attaches
 *     NO listener, so keys never fire stale commands;
 *   - held-key auto-repeat is ignored (one keypress = one action);
 *   - modifier combos (Ctrl/Meta/Alt+…) pass through untouched — the
 *     browser keeps its shortcuts;
 *   - typing in a text field (lobby name input, future chat) is never
 *     hijacked;
 *   - Space's default is prevented, which both stops page scrolling and
 *     suppresses the native activation of a FOCUSED button — so a focused
 *     Confirm button cannot double-fire (the hook clicks it exactly once).
 */
export function useMatchKeyboard({
  active,
  onPower,
  onConfirm,
}: {
  /** Whether the local player may act right now (aiming, unconfirmed). */
  active: boolean;
  onPower: (power: number) => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!active) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return; // one keypress = one action
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // Never intercept typing in a text field.
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key === " " || event.code === "Space") {
        // preventDefault: no page scroll, and a focused button (e.g.
        // Confirm itself) is not ALSO activated natively — exactly one
        // confirm per press.
        event.preventDefault();
        onConfirm();
        return;
      }

      // Digit → power level. Matches the top-row digit (event.key) and
      // the numpad digit (event.code) alike; anything else is ignored.
      const byKey = /^([0-9])$/.exec(event.key)?.[1];
      const byCode = /^Numpad([0-9])$/.exec(event.code)?.[1];
      const digit = byKey ?? byCode;
      if (digit === undefined) return;
      const level = Number(digit);
      const { min, max } = CONFIG.power;
      if (level < min || level > max) return;
      onPower(level);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, onPower, onConfirm]);
}
