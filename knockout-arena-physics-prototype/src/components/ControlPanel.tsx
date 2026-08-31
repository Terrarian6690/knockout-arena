import { CONFIG } from "../game/config";
import { PowerSelector } from "./PowerSelector";
import { cn } from "../utils/cn";
import type { GamePhase } from "../game/types";

/**
 * Bottom control bar: power selector, current selection readout, and the
 * launch / reset buttons.
 */
interface ControlPanelProps {
  phase: GamePhase;
  power: number;
  onPowerChange: (power: number) => void;
  onLaunch: () => void;
  onReset: () => void;
}

export function ControlPanel({
  phase,
  power,
  onPowerChange,
  onLaunch,
  onReset,
}: ControlPanelProps) {
  const aiming = phase === "aiming";
  const finished = phase === "finished";

  return (
    <div className="flex flex-col items-center justify-center gap-4 border-t border-white/10 bg-white/[0.02] px-4 py-4 sm:flex-row sm:gap-8 sm:py-5">
      <PowerSelector power={power} disabled={!aiming} onChange={onPowerChange} />

      {/* Current power readout */}
      <div className="text-center">
        <div className="text-[11px] uppercase tracking-widest text-white/40">
          Power
        </div>
        <div className="text-3xl font-black tabular-nums text-amber-400">
          {power}
        </div>
        <div className="text-[11px] text-white/40">/ {CONFIG.power.max}</div>
      </div>

      <div className="flex items-center gap-3">
        {!finished ? (
          <button
            type="button"
            onClick={onLaunch}
            disabled={!aiming}
            className={cn(
              "rounded-xl px-7 py-3 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
              "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
              "hover:from-amber-300 hover:to-orange-500 active:scale-95",
              "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            )}
          >
            {aiming ? "Launch" : "…"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onReset}
            className="rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 px-7 py-3 text-base font-bold uppercase tracking-wide text-white shadow-lg shadow-emerald-900/40 transition-all hover:from-emerald-300 hover:to-teal-500 active:scale-95"
          >
            Play again
          </button>
        )}

        <button
          type="button"
          onClick={onReset}
          className="rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 active:scale-95"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
