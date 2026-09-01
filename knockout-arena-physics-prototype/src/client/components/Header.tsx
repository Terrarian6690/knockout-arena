import type { GamePhase } from "../../game";

/**
 * Minimal top bar with the game title and a phase badge. Once a match is
 * finished the badge announces the winner (a multi-player concern already
 * supported by the engine) or the knockout.
 */
interface HeaderProps {
  phase: GamePhase;
  /** Winner display name when the match finished with a survivor. */
  winnerName: string | null;
}

const PHASE_BADGE: Record<Exclude<GamePhase, "finished">, { label: string; className: string }> = {
  aiming: { label: "Aim your knockout", className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" },
  moving: { label: "In motion…", className: "bg-amber-500/15 text-amber-300 border-amber-400/30" },
};

const FINISHED_WIN_BADGE = {
  label: "Winner!",
  className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
};
const FINISHED_LOSS_BADGE = {
  label: "Knocked out!",
  className: "bg-red-500/15 text-red-300 border-red-400/30",
};

export function Header({ phase, winnerName }: HeaderProps) {
  const badge =
    phase === "finished"
      ? winnerName
        ? { ...FINISHED_WIN_BADGE, label: `🏆 ${winnerName} wins!` }
        : FINISHED_LOSS_BADGE
      : PHASE_BADGE[phase];
  return (
    <header className="flex items-center justify-between px-4 py-3 sm:px-6">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-lg font-black text-white shadow-lg shadow-orange-900/40">
          KA
        </div>
        <div className="leading-tight">
          <h1 className="text-lg font-bold tracking-tight text-white">
            Knockout Arena
          </h1>
          <p className="text-[11px] text-white/40">Single-player prototype</p>
        </div>
      </div>

      <span
        className={`rounded-full border px-3 py-1 text-xs font-semibold ${badge.className}`}
      >
        {badge.label}
      </span>
    </header>
  );
}
