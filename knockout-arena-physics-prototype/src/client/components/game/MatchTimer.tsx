import { useEffect, useState } from "react";
import type { GamePhase } from "../../../game";
import { cn } from "../../utils/cn";

/** Remaining time at (and below) which the timer switches to urgent. */
const URGENT_REMAINING_MS = 30_000;
/**
 * How often the clock is SAMPLED. The component re-renders only when the
 * displayed second actually changes (see below), so this is a sampling
 * rate, not a render rate: the UI updates ~1×/second regardless.
 */
const SAMPLE_MS = 250;

/** Whole seconds remaining until an absolute deadline, clamped at zero. */
function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** `mm:ss` — 4:00, 3:59, … 0:00. */
export function formatMatchClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The MATCH TIME LIMIT display — PURE PRESENTATION of the authoritative
 * deadline the server stamps on every snapshot (`snapshot.matchDeadline`:
 * an absolute server wall-clock timestamp).
 *
 * It is a clock face and nothing more. It NEVER ends a match, never
 * sends a command, and nothing gameplay-related keys off it: the server
 * alone enforces the limit, and when it does, the next authoritative
 * snapshot switches the phase to "finished" — which is what makes the
 * winner UI appear and this timer disappear.
 *
 * RENDER DISCIPLINE: the deadline is absolute, so the remaining time is
 * recomputed from `Date.now()` rather than counted down locally. The
 * interval samples 4×/second for accuracy but commits state ONLY when
 * the whole second being displayed changes — so React re-renders about
 * once per second, never per animation frame. (The arena canvas is
 * painted by its own rAF loop outside React; this badge cannot affect
 * it.)
 *
 * Because nothing is stored across renders, a reconnecting client shows
 * the correct remaining time from the very first snapshot, and a late
 * snapshot cannot make the display drift or jump backwards: the value is
 * always `deadline - now`.
 */
export function MatchTimer({
  phase,
  deadline,
}: {
  readonly phase: GamePhase;
  readonly deadline: number | null | undefined;
}) {
  // Presentation-only metadata: tolerate absent (older server) or
  // malformed values without ever affecting the game view.
  const target = typeof deadline === "number" ? deadline : null;
  const live = target !== null && phase !== "finished";

  const [remaining, setRemaining] = useState(() =>
    target === null ? 0 : secondsLeft(target, Date.now())
  );

  useEffect(() => {
    if (!live || target === null) return;
    // Reflect the new deadline immediately, then keep sampling.
    setRemaining(secondsLeft(target, Date.now()));
    const id = setInterval(() => {
      const next = secondsLeft(target, Date.now());
      // The re-render gate: identical seconds are dropped, so this
      // interval costs one render per second at most.
      setRemaining((prev) => (prev === next ? prev : next));
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [live, target]);

  // No live match timer: the lobby, a finished match (the winner UI owns
  // the screen then) or a server that does not send the field.
  if (!live || target === null) return null;

  const urgent = remaining * 1000 <= URGENT_REMAINING_MS;

  return (
    <span
      data-testid="match-timer"
      data-urgent={urgent ? "true" : "false"}
      role="timer"
      aria-label={`Match time remaining: ${formatMatchClock(remaining)}`}
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1 font-mono tabular-nums",
        urgent
          ? "animate-pulse border-red-400/40 bg-red-500/15 text-red-300"
          : "border-sky-400/30 bg-sky-500/10 text-sky-200"
      )}
    >
      {/* Hidden below sm so the badge fits narrow phone headers; the
          accessible name above keeps the meaning for screen readers. */}
      <span className="hidden text-[10px] font-semibold uppercase tracking-wider opacity-70 sm:inline">
        Match
      </span>
      <span
        data-testid="match-timer-clock"
        className="text-lg font-bold leading-none"
      >
        {formatMatchClock(remaining)}
      </span>
    </span>
  );
}
