import { useEffect, useState } from "react";
import type { GamePhase } from "../../../game";
import { cn } from "../../utils/cn";

/** Remaining time at (and below) which the countdown switches to urgent. */
const URGENT_REMAINING_MS = 3_000;
/** Display refresh rate: a visual ticker, never a gameplay timer. */
const TICK_MS = 100;

/**
 * The round decision countdown — PURE PRESENTATION of the authoritative
 * deadline the server stamps on every aiming snapshot
 * (`snapshot.roundDeadline`: an absolute server wall-clock timestamp).
 *
 * This is a display ticker and nothing more. It NEVER sends a command,
 * never resolves a round, and nothing gameplay-related keys off it — the
 * server alone decides when a round ends, and when it does the next
 * authoritative snapshot changes the phase, which unmounts this badge.
 * The local clock is not assumed to be synchronized with the server:
 * `remaining` is presentation-only, clamps at zero, and simply holds 0
 * while the client waits for the authoritative post-deadline snapshot.
 *
 * Everything is derived from the CURRENT snapshot props: a new round's
 * snapshot carries a NEW deadline and the display follows it on the next
 * tick, so a stale countdown can never leak into a newer round (there is
 * no locally stored deadline to restore — not even across a reconnect).
 */
export function RoundCountdown({
  phase,
  deadline,
}: {
  readonly phase: GamePhase;
  readonly deadline: number | null | undefined;
}) {
  // Presentation-only metadata: tolerate absent (older server) or
  // malformed values without ever affecting the game view.
  const target = typeof deadline === "number" ? deadline : null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (target === null || phase !== "aiming") return;
    // Refresh immediately for the new round, then keep the display
    // ticking. This interval renders a number — it is NOT a second
    // gameplay timer and cannot affect the match in any way.
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [target, phase]);

  // Only the aiming phase of a live round has decision time. Moving,
  // finished and lobby/waiting states never show an active countdown.
  if (phase !== "aiming" || target === null) return null;

  const remainingMs = Math.max(0, target - nowMs); // clamps: never negative
  const seconds = Math.ceil(remainingMs / 1000);
  const urgent = remainingMs <= URGENT_REMAINING_MS;

  return (
    <span
      data-testid="round-countdown"
      data-urgent={urgent ? "true" : "false"}
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1 font-mono tabular-nums",
        urgent
          ? "animate-pulse border-red-400/40 bg-red-500/15 text-red-300"
          : "border-amber-400/30 bg-amber-500/10 text-amber-200"
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
        Decision time
      </span>
      <span
        data-testid="round-countdown-seconds"
        className="text-lg font-bold leading-none"
      >
        {seconds}
      </span>
    </span>
  );
}
