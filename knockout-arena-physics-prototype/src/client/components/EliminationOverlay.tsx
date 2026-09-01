/**
 * Full-canvas overlay shown when the match is finished. In the single-player
 * client the local pawn has been knocked out (no survivor); in a future
 * multi-player client it also covers the victory case.
 */
interface EliminationOverlayProps {
  /** Whether the local player's pawn won the match. */
  won: boolean;
  onReset: () => void;
}

export function EliminationOverlay({ won, onReset }: EliminationOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      <div
        className={`pointer-events-auto flex flex-col items-center gap-4 rounded-2xl border bg-slate-900/90 px-8 py-7 text-center shadow-2xl ${
          won ? "border-emerald-400/30" : "border-red-400/30"
        }`}
      >
        <div className="text-5xl">{won ? "🏆" : "💥"}</div>
        <h2
          className={`text-2xl font-black tracking-tight ${
            won ? "text-emerald-300" : "text-red-300"
          }`}
        >
          {won ? "Victory!" : "Knocked Out!"}
        </h2>
        <p className="max-w-xs text-sm text-white/60">
          {won
            ? "Every rival pawn left the arena. Flawless round."
            : "Your pawn left the arena. Aim carefully and watch your momentum next time."}
        </p>
        <button
          type="button"
          onClick={onReset}
          className="rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow-lg shadow-emerald-900/40 transition-all hover:from-emerald-300 hover:to-teal-500 active:scale-95"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
