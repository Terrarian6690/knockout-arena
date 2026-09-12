import { useEffect, useRef, useState } from "react";
import type { PawnSnapshot } from "../../../game";
import { cn } from "../../utils/cn";
import { handleTrapKeyDown, useDialogFocus } from "./focusTrap";

/**
 * Match result overlay. The winner (or the absence of one) is entirely
 * the server's verdict — `winnerId` from the finished snapshot /
 * match_finished message; the client only decides which emoji to show.
 * The way out of a finished match is Leave Room (protocol v1 has no
 * rematch yet — resetMatch is server-side only).
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
  onLeave: () => void;
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
          leaves the live regions outside untouched. */}
      <div
        ref={dialogRef}
        data-testid="match-result"
        role="dialog"
        aria-modal="true"
        aria-labelledby="match-result-title"
        aria-describedby="match-result-detail"
        tabIndex={-1}
        onKeyDown={(event) => handleTrapKeyDown(event, dialogRef.current)}
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
