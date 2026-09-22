import { cn } from "../../utils/cn";
import { useMatchKeyboard } from "../../useMatchKeyboard";
import { PowerMeter } from "./PowerMeter";

/**
 * The multiplayer control bar — the bottom strip of the match screen:
 * the power arrow (1..5) and the CONFIRM control. Every control only SENDS AN INTENT: the displayed
 * power is the authoritative one (optionally the local pending choice
 * until the next server snapshot replaces it), and Confirm locks in the
 * player's CURRENT aim + power for the CURRENT round (confirmLaunch) —
 * it never starts the movement itself; the server resolves the round
 * when everyone eligible has confirmed or its deadline expires. Once
 * confirmed, everything is disabled and reads back the locked choice.
 */
interface MatchControlsProps {
  /** The power to display (authoritative, or the pending local choice). */
  readonly power: number;
  /** Whether the local player may act right now (this round, unconfirmed). */
  readonly canAct: boolean;
  /**
   * Whether the local player has already locked in their move for the
   * current round (waiting for the other players) — only used to label
   * the disabled confirm control.
   */
  readonly lockedIn: boolean;
  onPowerChange: (power: number) => void;
  onLaunch: () => void;
}

export function MatchControls({
  power,
  canAct,
  lockedIn,
  onPowerChange,
  onLaunch,
}: MatchControlsProps) {
  // Keyboard shortcuts: digits 1..5 pick the power level, Space presses
  // Confirm. Same commands as the on-screen controls — and only while the
  // player may actually act (the hook attaches no listener otherwise).
  useMatchKeyboard({
    active: canAct,
    onPower: onPowerChange,
    onConfirm: onLaunch,
  });

  return (
    <div
      data-testid="match-controls"
      // ONE compact row on every screen: on a phone the arena must own
      // the display, so the bar is meter + Confirm side by side, no
      // captions, minimal padding (~68px tall). Desktop is a row of the
      // same two controls without the captions either, ~80px tall —
      // about 30px shorter than the old captioned stack (the controls
      // carry their own labels: aria-label "Power", per-button digits,
      // and the button text itself).
      className="flex items-center justify-center gap-3 border-t border-white/10 bg-white/[0.02] px-3 py-1.5 sm:gap-8 sm:px-4 sm:py-2"
    >
      {/* The power arrow: grows thin+green (weak) → wide+red (strong). */}
      <div className="flex min-w-0 flex-1 items-center justify-center sm:flex-none">
        <PowerMeter
          power={power}
          disabled={!canAct}
          onChange={onPowerChange}
        />
      </div>

      {/* The numeric power readout ("3" over "/ 5") that used to sit
          between the selector and Confirm is gone (Task 31), as is the
          "Level" caption above it (Task 29). It described a value the
          selector already states twice over: every level button renders
          its own digit, and the selected one is an inverted white chip
          with a ring — never colour alone.

          Nothing accessible was lost with it. The readout was plain
          text with no aria-live, no aria-label and no id anything
          pointed at; the PowerMeter owns the whole accessibility
          contract (role="group" + aria-label="Power", per-button
          aria-label="Power N" and aria-pressed on the current level),
          so a screen reader still hears which power is selected. */}

      <div className="flex shrink-0 items-center">
        {/* The commitment: CURRENT aim + CURRENT power → CONFIRM. The
            button never launches by itself — the round resolves on the
            server (everyone confirmed, or its deadline). */}
        <button
          type="button"
          onClick={onLaunch}
          disabled={!canAct}
          data-testid="launch"
          className={cn(
            "rounded-xl px-4 py-2 text-sm font-bold uppercase tracking-wide shadow-lg transition-all sm:px-7 sm:py-3 sm:text-base",
            canAct
              ? "bg-gradient-to-br from-amber-400 to-orange-600 text-white hover:from-amber-300 hover:to-orange-500 active:scale-95 shadow-orange-900/40"
              : "bg-gradient-to-br from-emerald-500/80 to-emerald-600/80 text-white shadow-emerald-900/40",
            "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          )}
        >
          {canAct
            ? "Confirm"
            : lockedIn
              ? "Wait for the next game"
              : "Waiting for round…"}
        </button>
      </div>
    </div>
  );
}
