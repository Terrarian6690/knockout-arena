import { useEffect, useState } from "react";
import type { GameStateSnapshot } from "../../../game";
import { cn } from "../../utils/cn";

/** Remaining time at (and below) which the warning switches to urgent. */
const URGENT_REMAINING_MS = 3_000;
/** Display refresh rate: a visual ticker, never a gameplay timer. */
const TICK_MS = 100;

/**
 * The shrinking-arena warning — PURE PRESENTATION of authoritative state.
 *
 * Everything it shows comes from the snapshot the server sent:
 *
 *   - WHETHER to warn: `snapshot.arena.shrinkWarning`, computed by the
 *     engine's projection from the authoritative shrink schedule. The
 *     client never counts rounds and has no schedule of its own, so it
 *     cannot warn at the wrong time — or keep warning after the arena
 *     reached its minimum (the flag simply stops being set);
 *   - the COUNTDOWN: the same server-stamped absolute deadline the round
 *     countdown uses (`snapshot.roundDeadline`) — the shrink lands when
 *     this round resolves, so its remaining time IS the time until the
 *     arena shrinks. There is no second, independent client timer;
 *   - the SIZES: the current and next radius, both authoritative.
 *
 * Reconnects and late snapshots are safe by construction: nothing is
 * stored across renders (no local deadline, no remembered round count),
 * so whatever the latest snapshot says is what shows — a client that
 * joins mid-match immediately displays the correct warning state, and
 * the warning disappears the moment a post-shrink snapshot arrives.
 *
 * It NEVER interferes with play: the overlay is `pointer-events-none` and
 * sits at the top of the arena area, so aiming clicks pass straight
 * through to the canvas and the Confirm controls stay reachable.
 */
export function ShrinkWarning({
  snapshot,
}: {
  readonly snapshot: GameStateSnapshot;
}) {
  const arena = snapshot.arena;
  // Presentation-only metadata: tolerate absent (older server) or
  // malformed values without ever affecting the game view.
  const active = arena?.shrinkWarning === true && snapshot.phase === "aiming";
  const target =
    typeof snapshot.roundDeadline === "number" ? snapshot.roundDeadline : null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active || target === null) return;
    setNowMs(Date.now());
    // Renders a number. NOT a gameplay timer: the server alone decides
    // when the round ends and the arena shrinks.
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active, target]);

  if (!active) return null;

  const remainingMs = target === null ? null : Math.max(0, target - nowMs);
  const seconds = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  const urgent = remainingMs !== null && remainingMs <= URGENT_REMAINING_MS;

  return (
    <div
      // pointer-events-none: the warning must never swallow an aim click.
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 pt-3"
    >
      <div
        data-testid="shrink-warning"
        data-urgent={urgent ? "true" : "false"}
        role="status"
        aria-live="polite"
        aria-label={
          seconds === null
            ? "Warning: the arena is about to shrink"
            : `Warning: the arena shrinks in ${seconds} seconds`
        }
        className={cn(
          "flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm shadow-lg backdrop-blur-sm",
          urgent
            ? "animate-pulse border-red-400/50 bg-red-500/20 text-red-200"
            : "border-orange-400/40 bg-orange-500/15 text-orange-200"
        )}
      >
        <span aria-hidden="true" className="text-base leading-none">
          ⚠
        </span>
        <span className="font-semibold">Arena shrinking</span>
        {seconds !== null && (
          <span
            data-testid="shrink-warning-seconds"
            className="font-mono text-base font-bold tabular-nums"
          >
            {seconds}s
          </span>
        )}
        {arena?.nextRadius != null && (
          <span
            data-testid="shrink-warning-radius"
            className="hidden text-xs opacity-80 sm:inline"
          >
            {Math.round(arena.radius)} → {Math.round(arena.nextRadius)}
          </span>
        )}
      </div>
    </div>
  );
}
