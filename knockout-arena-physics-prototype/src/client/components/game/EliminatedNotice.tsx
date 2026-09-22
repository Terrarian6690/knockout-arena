import type { GameStateSnapshot } from "../../../game";

/**
 * The eliminated player's on-screen DEATH NOTICE.
 *
 * When the local player's pawn leaves the arena the match keeps running
 * without them, so — unlike the solo screen's full overlay — this is a
 * COMPACT BADGE IN THE TOP BAR (requested: it must never cover the
 * arena). The board stays 100% visible: the notice rides in the header
 * next to the clocks, impossible to miss (red card, 💥, "Knocked
 * out!"), announced via role=alert, yet it never traps the pointer and
 * never overlaps the board the eliminated player is now watching. The
 * finished phase hands the screen to the match result overlay, so the
 * notice stands down there.
 *
 * Pure presentation of the authoritative viewer projection: the server's
 * snapshot says the local pawn is eliminated — the client never computes
 * an elimination of its own.
 */
export function EliminatedNotice({
  snapshot,
}: {
  readonly snapshot: GameStateSnapshot;
}) {
  const localPawn = snapshot.pawns.find(
    (pawn) => pawn.id === snapshot.localPawnId
  );
  if (!localPawn?.eliminated || snapshot.phase === "finished") return null;

  return (
    <div
      data-testid="eliminated-notice"
      className="pointer-events-none flex shrink-0 items-center rounded-xl border border-red-400/40 bg-red-950/80 px-3 py-1.5 shadow-lg"
    >
      <span
        role="alert"
        className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-red-200"
      >
        <span aria-hidden="true" className="text-base leading-none">
          💥
        </span>
        Knocked out!
        <span className="text-xs font-medium normal-case tracking-normal text-white/60">
          watching the rest of the match
        </span>
      </span>
    </div>
  );
}
