import { useEffect, useState } from "react";
import { cn } from "../../utils/cn";

/** Remaining time at (and below) which the countdown reads as urgent. */
const URGENT_REMAINING_MS = 10_000;
/** Display refresh rate: a visual ticker, never a gameplay timer. */
const TICK_MS = 100;

/**
 * The public-room automatic-start countdown (Task 28) — PURE
 * PRESENTATION of the authoritative deadline the server puts on every
 * room_state (`autoStartDeadline`: an absolute server timestamp).
 *
 * This is the same contract the round countdown follows (Task 22): the
 * component holds NO duration logic. It does not know that two players
 * wait five minutes and six wait three seconds — it only renders the
 * time left until a timestamp the server chose. When the roster changes
 * the server sends a new deadline and the display simply follows it, so
 * the table can change server-side without touching this file.
 *
 * It never starts a match. The server's own timer does that and then
 * broadcasts the room as "playing"; this badge unmounts with the
 * waiting screen.
 */
export function AutoStartCountdown({
  deadline,
}: {
  /** Absolute server timestamp, or null when no countdown is armed. */
  readonly deadline: number | null | undefined;
}) {
  // Presentation-only metadata: tolerate absent (older server) or
  // malformed values without ever affecting the lobby.
  const target = typeof deadline === "number" ? deadline : null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (target === null) return;
    // Refresh immediately for the new deadline, then keep ticking. This
    // interval renders a number — it is NOT a second start timer and
    // cannot start, delay or cancel a match.
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [target]);

  if (target === null) return null;

  const remainingMs = Math.max(0, target - nowMs); // clamps: never negative
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const urgent = remainingMs <= URGENT_REMAINING_MS;

  return (
    <div
      data-testid="auto-start-countdown"
      data-urgent={urgent ? "true" : "false"}
      data-remaining-seconds={totalSeconds}
      role="timer"
      aria-label={`Match starts automatically in ${describe(totalSeconds)}`}
      className={cn(
        "flex flex-col items-center gap-0.5 rounded-xl border px-4 py-2 text-center transition-colors",
        urgent
          ? "animate-pulse border-amber-400/50 bg-amber-500/15"
          : "border-white/10 bg-white/[0.03]"
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-widest text-white/50">
        Match starts in
      </span>
      <span
        data-testid="auto-start-countdown-time"
        className={cn(
          "font-mono text-2xl font-bold leading-none tabular-nums",
          urgent ? "text-amber-200" : "text-white"
        )}
      >
        {clockText(totalSeconds)}
      </span>
    </div>
  );
}

/** m:ss above a minute, plain seconds below it — never a bare "0:07". */
function clockText(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The same duration in words, for the accessible name. */
function describe(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minutePart = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (seconds === 0) return minutePart;
  return `${minutePart} ${seconds} second${seconds === 1 ? "" : "s"}`;
}
