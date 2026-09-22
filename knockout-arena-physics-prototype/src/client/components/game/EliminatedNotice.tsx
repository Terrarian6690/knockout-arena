import { useEffect, useState } from "react";
import type { GameStateSnapshot } from "../../../game";

/**
 * The eliminated player's on-screen DEATH NOTICE.
 *
 * When the local player's pawn leaves the arena the match keeps running
 * without them, so — unlike the solo screen's full overlay — this is a
 * non-blocking banner over the arena, in the SAME spot as always (top
 * centre). It is impossible to miss (red card, 💥, "Knocked out!") and
 * carries an OK BUTTON: clicking it clears the message for good — the
 * player has acknowledged it and keeps watching the board unobstructed.
 * The notice comes back only for a NEW elimination (the next game); it
 * stands down on its own when the finished phase hands the screen to
 * the match result overlay.
 *
 * Only the card itself (with its button) takes pointer input — the
 * wrapper stays inert, so nothing else on the board is blocked.
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
  const showing =
    localPawn?.eliminated === true && snapshot.phase !== "finished";

  // Dismissed stays dismissed for the WHOLE elimination episode; a new
  // one (the player alive again — i.e. the next game — then knocked out
  // again) arms the notice afresh.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!showing) setDismissed(false);
  }, [showing]);

  if (!showing || dismissed) return null;

  return (
    <div
      data-testid="eliminated-notice"
      className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center px-4"
    >
      <div
        role="alert"
        className="pointer-events-auto flex items-center gap-3 rounded-xl border border-red-400/40 bg-red-950/80 px-5 py-3 shadow-lg backdrop-blur"
      >
        <span aria-hidden="true" className="text-2xl leading-none">
          💥
        </span>
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-base font-black uppercase tracking-wide text-red-200">
            Knocked out!
          </span>
          <span className="text-xs text-white/60">
            Your pawn left the arena — watching the rest of the match.
          </span>
        </div>
        {/* The acknowledgement: clears the notice until a NEW elimination. */}
        <button
          type="button"
          data-testid="dismiss-eliminated-notice"
          onClick={() => setDismissed(true)}
          className="ml-2 rounded-lg border border-white/20 bg-white/10 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white transition-colors hover:border-white/40 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          OK
        </button>
      </div>
    </div>
  );
}
