import { useEffect, useRef, useState } from "react";
import type { PawnSnapshot } from "../../../game";
import { cn } from "../../utils/cn";
import { LeaveRoomButton } from "../lobby/LeaveRoomButton";
import { handleTrapKeyDown, useDialogFocus } from "./focusTrap";

/**
 * Match result overlay. The winner (or the absence of one) is entirely
 * the server's verdict — `winnerId` from the finished snapshot /
 * match_finished message; the client only decides which emoji to show.
 *
 * Two ways out of a finished match (Task 25), because they are genuinely
 * different intentions and must not be one button:
 *
 *   - PLAY AGAIN (`onPlayAgain`) — stay. Keeps the seat, the room and the
 *     room code; the server moves the room back to "waiting" and the
 *     normal pre-match lobby returns, ready for the host to start the
 *     next match. This is the primary action: after a match with friends
 *     the overwhelmingly likely intent is another match.
 *   - LEAVE ROOM (`onLeave`) — go. The original, unchanged path: release
 *     the seat and return to the home screen.
 *
 * `onPlayAgain` is OPTIONAL. When it is absent the overlay renders
 * exactly as it did before Task 25 (a single leave button), so a caller
 * that has no room to return to never shows a dead affordance.
 *
 * Accessibility (Task 9): the visible result is three separate pieces of
 * text (emoji, headline, detail sentence), which is right for sighted
 * players but makes a poor announcement. A visually hidden polite live
 * region carries ONE concise sentence instead — the same public verdict
 * the overlay already shows, never anything private (no aim, no power,
 * no other player's readiness).
 *
 * The region is deliberately mounted EMPTY and filled one effect later:
 * assistive technology reliably announces a change inside an existing
 * live region, whereas a region inserted with its text already in place
 * is often missed. The effect is keyed on the announcement text, so the
 * steady stream of re-renders a finished match still receives (snapshot
 * pushes, match_finished, connection changes) leaves the DOM text
 * untouched and nothing is announced twice.
 */
interface MatchResultOverlayProps {
  /** Server-reported winner pawn id, or null when nobody survived. */
  readonly winnerId: string | null;
  /** This viewer's pawn id (from the snapshot's localPawnId). */
  readonly localPawnId: string | null;
  readonly pawns: readonly PawnSnapshot[];
  /** Release the seat and go back to the home screen. */
  onLeave: () => void;
  /**
   * Stay in the room and return it to its waiting lobby for another
   * match. Optional: when omitted the overlay offers only `onLeave`,
   * which is precisely its pre-Task-25 behaviour.
   */
  onPlayAgain?: () => void;
  /**
   * Where focus goes when the overlay closes, if whatever held focus
   * when the match ended is gone by then (the match controls unmount
   * with the running match, so this is the usual case, not the rare
   * one). Read once, at mount.
   */
  getRestoreFocusFallback?: () => HTMLElement | null;
}

export function MatchResultOverlay({
  winnerId,
  localPawnId,
  pawns,
  onLeave,
  onPlayAgain,
  getRestoreFocusFallback,
}: MatchResultOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const won = winnerId !== null && winnerId === localPawnId;
  const winnerName =
    winnerId === null
      ? null
      : pawns.find((pawn) => pawn.id === winnerId)?.name ?? winnerId;

  // One sentence, built from the SAME authoritative verdict the overlay
  // renders visually: outcome first (it is what matters), then who won.
  const announcement =
    winnerId === null
      ? "Match over. No survivor — every pawn left the arena."
      : won
        ? "Match over. Victory! You win the match."
        : `Match over. You were knocked out. ${winnerName} wins the match.`;

  const spokenResult = useDelayedAnnouncement(announcement);

  // Focus management (Task 11). Separate concern, separate hook: it
  // moves focus through refs only and sets no state, so it cannot
  // re-run or duplicate the announcement above.
  useDialogFocus(dialogRef, getRestoreFocusFallback);

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      {/* The announcement. Visually hidden (the sighted presentation
          below is unchanged), polite so it never interrupts, and atomic
          so the whole sentence is read as one. */}
      <div
        data-testid="match-result-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {spokenResult}
      </div>
      {/* The dialog proper. tabIndex={-1} makes it programmatically
          focusable without adding a Tab stop, so focus can land on the
          result itself and a screen reader reads the headline and
          detail (via aria-labelledby/-describedby) before the player
          reaches "Back to lobby". Tab is contained on keydown, which
          leaves the live regions outside untouched.

          Escape (Task 16) is handled by that same keydown handler and
          forwards to a real button's callback — never a parallel exit,
          so there is one dismissal path, one navigation and one focus
          restoration. WHICH button changed in Task 25: Escape now means
          "dismiss this dialog", and the least destructive reading of
          that is Play Again (stop showing me the result, put me back in
          my room) rather than Leave (give up the seat). Escape is a
          reflex key; it must not be the one that throws away a seat and
          a room code. With no `onPlayAgain` there is nothing to dismiss
          to, so it falls back to `onLeave` — the exact pre-Task-25
          behaviour. Because the handler is bound to the dialog, Escape
          can only fire while focus is inside it. */}
      <div
        ref={dialogRef}
        data-testid="match-result"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-result-title"
        aria-describedby="match-result-detail"
        tabIndex={-1}
        onKeyDown={(event) =>
          handleTrapKeyDown(event, dialogRef.current, onPlayAgain ?? onLeave)
        }
        className={cn(
          "pointer-events-auto flex flex-col items-center gap-4 rounded-2xl border bg-slate-900/90 px-8 py-7 text-center shadow-2xl outline-none",
          won ? "border-emerald-400/30" : "border-red-400/30"
        )}
      >
        <div aria-hidden="true" className="text-5xl">{winnerId === null ? "💥" : won ? "🏆" : "💥"}</div>
        <h2
          id="match-result-title"
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
        <p id="match-result-detail" className="max-w-xs text-sm text-white/60">
          {winnerId === null
            ? "Every pawn left the arena — total knockout!"
            : won
              ? "Every rival pawn left the arena. Flawless round."
              : `${winnerName} wins the match.`}
        </p>
        {/* Actions, in intent order: staying is the likely choice and
            comes first, so it is also the first Tab stop and the target
            of the very first Tab out of the dialog container. Leaving
            keeps its original `back-to-lobby` test id deliberately —
            it is the same action on the same element, so the Task 11/16
            focus, trap and Escape coverage keeps pointing at it. */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {onPlayAgain !== undefined && (
            <button
              type="button"
              onClick={onPlayAgain}
              data-testid="play-again"
              className="rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 px-6 py-2.5 text-sm font-bold uppercase tracking-wide text-white shadow-lg shadow-emerald-900/40 transition-all hover:from-emerald-300 hover:to-teal-500 active:scale-95"
            >
              Play again
            </button>
          )}
          {/* Task 27: the same exit affordance as the waiting room — the
              red icon in the top-left corner, no text.

              Two deliberate details:
               - it stays a DOM CHILD OF THE DIALOG, because the Task 11
                 trap walks the dialog's descendants: the exit must stay
                 inside the trap and in the tab order, after "Play again";
               - it is `absolute`, not `fixed`, so it anchors to the
                 overlay root (the only positioned ancestor), which spans
                 the match area. That lands it in the same corner as the
                 waiting room's exit instead of on top of the match
                 header's logo. */}
          <LeaveRoomButton
            onLeave={onLeave}
            testId="back-to-lobby"
            label={onPlayAgain === undefined ? "Back to lobby" : "Leave room"}
            className="absolute left-2 top-2 z-30 sm:left-4 sm:top-3"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Publish `text` into a live region one commit AFTER mount, so assistive
 * technology sees a CHANGE inside a region that already exists (a region
 * rendered with its content already in place is frequently not
 * announced).
 *
 * Re-announcing is prevented by the dependency: the effect only runs
 * again when the sentence itself differs. A finished match keeps
 * re-rendering — further snapshots, match_finished, connection status —
 * and every one of those produces the identical string, so the DOM text
 * never changes and the region stays silent.
 */
function useDelayedAnnouncement(text: string): string {
  const [published, setPublished] = useState("");
  useEffect(() => {
    // A frame is not required; a microtask-after-paint is enough and
    // keeps the test environment (jsdom, no rAF) behaving identically.
    const id = setTimeout(() => setPublished(text), 0);
    return () => clearTimeout(id);
  }, [text]);
  return published;
}
