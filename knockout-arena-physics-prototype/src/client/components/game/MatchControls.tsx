import { CONFIG } from "../../../game";
import { cn } from "../../utils/cn";
import { PowerSelector } from "../PowerSelector";

/**
 * The multiplayer control bar — same layout and visual identity as the
 * single-player ControlPanel, but every control only SENDS AN INTENT:
 * the displayed power is the authoritative one (optionally the local
 * pending choice until the next server snapshot replaces it), Launch
 * sends confirmLaunch, and there is deliberately NO reset (resetMatch is
 * a server-side operation, not exposed over the wire).
 */
interface MatchControlsProps {
  /** The power to display (authoritative, or the pending local choice). */
  readonly power: number;
  /** Whether the local player may act right now (their aiming turn). */
  readonly canAct: boolean;
  onPowerChange: (power: number) => void;
  onLaunch: () => void;
}

export function MatchControls({
  power,
  canAct,
  onPowerChange,
  onLaunch,
}: MatchControlsProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 border-t border-white/10 bg-white/[0.02] px-4 py-4 sm:flex-row sm:gap-8 sm:py-5">
      <PowerSelector power={power} disabled={!canAct} onChange={onPowerChange} />

      {/* Current power readout */}
      <div className="text-center">
        <div className="text-[11px] uppercase tracking-widest text-white/40">
          Power
        </div>
        <div
          data-testid="power-readout"
          className="text-3xl font-black tabular-nums text-amber-400"
        >
          {power}
        </div>
        <div className="text-[11px] text-white/40">/ {CONFIG.power.max}</div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onLaunch}
          disabled={!canAct}
          data-testid="launch"
          className={cn(
            "rounded-xl px-7 py-3 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
            "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
            "hover:from-amber-300 hover:to-orange-500 active:scale-95",
            "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          )}
        >
          {canAct ? "Launch" : "…"}
        </button>
      </div>
    </div>
  );
}
