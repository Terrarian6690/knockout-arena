import type { PawnSnapshot } from "../../../game";
import { cn } from "../../utils/cn";

/**
 * Match result overlay. The winner (or the absence of one) is entirely
 * the server's verdict — `winnerId` from the finished snapshot /
 * match_finished message; the client only decides which emoji to show.
 * The way out of a finished match is Leave Room (protocol v1 has no
 * rematch yet — resetMatch is server-side only).
 */
interface MatchResultOverlayProps {
  /** Server-reported winner pawn id, or null when nobody survived. */
  readonly winnerId: string | null;
  /** This viewer's pawn id (from the snapshot's localPawnId). */
  readonly localPawnId: string | null;
  readonly pawns: readonly PawnSnapshot[];
  onLeave: () => void;
}

export function MatchResultOverlay({
  winnerId,
  localPawnId,
  pawns,
  onLeave,
}: MatchResultOverlayProps) {
  const won = winnerId !== null && winnerId === localPawnId;
  const winnerName =
    winnerId === null
      ? null
      : pawns.find((pawn) => pawn.id === winnerId)?.name ?? winnerId;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      <div
        data-testid="match-result"
        className={cn(
          "pointer-events-auto flex flex-col items-center gap-4 rounded-2xl border bg-slate-900/90 px-8 py-7 text-center shadow-2xl",
          won ? "border-emerald-400/30" : "border-red-400/30"
        )}
      >
        <div className="text-5xl">{winnerId === null ? "💥" : won ? "🏆" : "💥"}</div>
        <h2
          className={cn(
            "text-2xl font-black tracking-tight",
            won ? "text-emerald-300" : "text-red-300"
          )}
        >
          {winnerId === null
            ? "No Survivor!"
            : won
              ? "Victory!"
              : "Knocked Out!"}
        </h2>
        <p className="max-w-xs text-sm text-white/60">
          {winnerId === null
            ? "Every pawn left the arena — total knockout!"
            : won
              ? "Every rival pawn left the arena. Flawless round."
              : `${winnerName} wins the match.`}
        </p>
        <button
          type="button"
          onClick={onLeave}
          data-testid="back-to-lobby"
          className="rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow-lg shadow-emerald-900/40 transition-all hover:from-emerald-300 hover:to-teal-500 active:scale-95"
        >
          Back to lobby
        </button>
      </div>
    </div>
  );
}
