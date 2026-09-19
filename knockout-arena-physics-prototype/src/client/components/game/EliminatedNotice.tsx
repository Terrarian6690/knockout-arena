import type { GameStateSnapshot } from "../../../game";

/**
 * The eliminated player's on-screen DEATH NOTICE.
 *
 * When the local player's pawn leaves the arena the match keeps running
 * without them, so — unlike the solo screen's full overlay — this is a
 * non-blocking banner over the arena: impossible to miss (red card, 💥,
 * "Knocked out!"), yet it never traps the pointer, never swallows an
 * aiming click, and never covers the board the eliminated player is now
 * watching. The finished phase hands the screen to the match result
 * overlay, so the notice stands down there.
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
      className="pointer-events-none absolute inset-x-0 top-14 z-20 flex justify-center px-4"
    >
      <div
        role="alert"
        className="flex items-center gap-3 rounded-xl border border-red-400/40 bg-red-950/80 px-5 py-3 shadow-lg backdrop-blur"
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
      </div>
    </div>
  );
}
