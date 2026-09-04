import { CONFIG } from "../../../game";
import { cn } from "../../utils/cn";
import { PowerMeter } from "./PowerMeter";

/**
 * The multiplayer control bar — the bottom strip of the match screen:
 * the horizontal power meter (1..5), the numeric power readout, and the
 * CONFIRM control. Every control only SENDS AN INTENT: the displayed
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
  return (
    <div
      data-testid="match-controls"
      className="flex flex-col items-center justify-center gap-4 border-t border-white/10 bg-white/[0.02] px-4 py-4 sm:flex-row sm:gap-8 sm:py-4"
    >
      {/* The power meter: horizontal wedge, weak (green) → strong (red). */}
      <div className="flex flex-col items-center gap-1.5">
        <div className="text-[11px] uppercase tracking-widest text-white/40">
          Power
        </div>
        <PowerMeter
          power={power}
          disabled={!canAct}
          onChange={onPowerChange}
        />
      </div>

      {/* Current power readout */}
      <div className="text-center">
        <div className="text-[11px] uppercase tracking-widest text-white/40">
          Level
        </div>
        <div
          data-testid="power-readout"
          className="text-3xl font-black tabular-nums text-amber-400"
        >
          {power}
        </div>
        <div className="text-[11px] text-white/40">/ {CONFIG.power.max}</div>
      </div>

      <div className="flex flex-col items-center gap-1">
        {/* The commitment: CURRENT aim + CURRENT power → CONFIRM. The
            button never launches by itself — the round resolves on the
            server (everyone confirmed, or its deadline). */}
        <div className="text-[11px] uppercase tracking-widest text-white/40">
          Lock aim + power
        </div>
        <button
          type="button"
          onClick={onLaunch}
          disabled={!canAct}
          data-testid="launch"
          className={cn(
            "rounded-xl px-7 py-3 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
            canAct
              ? "bg-gradient-to-br from-amber-400 to-orange-600 text-white hover:from-amber-300 hover:to-orange-500 active:scale-95 shadow-orange-900/40"
              : "bg-gradient-to-br from-emerald-500/80 to-emerald-600/80 text-white shadow-emerald-900/40",
            "disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          )}
        >
          {canAct ? "Confirm launch" : lockedIn ? "Confirmed — waiting…" : "…"}
        </button>
      </div>
    </div>
  );
}
