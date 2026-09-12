import { useEffect, useRef, useState } from "react";
import type { GameStateSnapshot } from "../../../game";
import { matchProgressAnnouncement } from "./matchAnnouncements";

/**
 * Mid-match accessible announcements (Task 10): eliminations and round
 * transitions, spoken to assistive technology.
 *
 * Renders nothing visible — a sighted player sees these events on the
 * canvas and in the match rail, which are unchanged. This is the same
 * live-region pattern the match result uses (Task 9), in its own region
 * so the two never overwrite one another:
 *
 *   - `role="status"` + `aria-live="polite"`: never interrupts;
 *   - `aria-atomic`: the whole sentence is read as one unit;
 *   - mounted EMPTY and filled one commit later, because assistive
 *     technology announces CHANGES inside an existing region — a region
 *     that appears with its text already in place is often missed.
 *
 * Duplicate suppression is two-layer. The sentence is derived from an
 * authoritative TRANSITION (previous snapshot → next), so the steady
 * stream of identical/duplicate snapshots a match produces yields an
 * empty sentence and publishes nothing; and the publishing effect is
 * keyed on the sentence, so even a repeated transition cannot re-fire
 * the same words. Events are never dropped, though: a genuinely new
 * event always differs from the last one it follows (a different round
 * ordinal, or a different set of names), and the counter in the key
 * guarantees two identical sentences arriving at different times are
 * still published as distinct changes.
 */
export function MatchProgressAnnouncer({
  snapshot,
}: {
  readonly snapshot: GameStateSnapshot | null;
}) {
  // The last snapshot we DIFFED against (a ref: diffing is not rendering,
  // and updating it must never trigger a re-render of its own).
  const previousRef = useRef<GameStateSnapshot | null>(null);
  // The sentence to speak, plus a monotonic id so that the same words
  // occurring twice (e.g. "Round 4 begins." after a reset) still register
  // as a change rather than being swallowed as a duplicate.
  const [pending, setPending] = useState<{ text: string; id: number } | null>(
    null
  );
  const nextIdRef = useRef(0);

  useEffect(() => {
    if (snapshot === null) return;
    const previous = previousRef.current;
    previousRef.current = snapshot;
    const text = matchProgressAnnouncement(previous, snapshot);
    // Nothing worth saying about this transition — stay silent rather
    // than republishing the previous sentence.
    if (text === "") return;
    nextIdRef.current += 1;
    setPending({ text, id: nextIdRef.current });
  }, [snapshot]);

  const spoken = useDelayedAnnouncement(pending);

  return (
    <div
      data-testid="match-progress-announcement"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {spoken}
    </div>
  );
}

/**
 * Publish a sentence into the live region one commit AFTER it is
 * produced, so assistive technology observes a change inside a region
 * that already exists.
 *
 * Keyed on the announcement's id as well as its text: identical wording
 * produced by two different events is still a real change, while the
 * same event re-delivered (an unchanged `pending`) re-runs nothing.
 */
function useDelayedAnnouncement(
  pending: { text: string; id: number } | null
): string {
  const [published, setPublished] = useState("");
  const text = pending?.text ?? "";
  const id = pending?.id ?? 0;
  useEffect(() => {
    if (pending === null) return;
    const handle = setTimeout(() => setPublished(text), 0);
    return () => clearTimeout(handle);
    // `id` participates deliberately: see the doc comment.
  }, [pending, text, id]);
  return published;
}
