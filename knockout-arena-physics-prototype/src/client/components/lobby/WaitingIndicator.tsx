import { cn } from "../../utils/cn";

/**
 * The "Waiting for players" banner that sits ABOVE the room panel.
 *
 * This is the room's live status line, lifted out of the panel so the
 * player reads the state of the room before the details of it. The three
 * dots are real elements rather than literal "…" text so they can be
 * animated in sequence (see `.ka-ellipsis-dot` in index.css).
 *
 * Accessibility:
 *   - the dots are decorative and `aria-hidden`; the accessible name
 *     comes from the visible label plus an explicit "…", so assistive
 *     tech reads "Waiting for players…" as one phrase rather than
 *     spelling out three bullets;
 *   - `role="status"` announces a state change (waiting → in progress)
 *     without stealing focus;
 *   - the animation is disabled under `prefers-reduced-motion`, where
 *     the dots stay fully visible — the text never loses meaning.
 */

/** The animated three-dot ellipsis. Decorative: hidden from a11y tree. */
export function AnimatedEllipsis({ className }: { readonly className?: string }) {
  return (
    <span
      data-testid="animated-ellipsis"
      aria-hidden="true"
      className={cn("inline-flex items-baseline", className)}
    >
      {[0, 1, 2].map((index) => (
        <span key={index} className="ka-ellipsis-dot">
          .
        </span>
      ))}
    </span>
  );
}

export interface WaitingIndicatorProps {
  /**
   * The status line's wording, WITHOUT its trailing ellipsis — the dots
   * are appended as animated elements.
   */
  readonly label: string;
  readonly className?: string;
  /**
   * Test id for the banner element. Defaults to `waiting-indicator`; the
   * room panel passes `room-state-badge` so the room's status keeps one
   * stable handle across all three room states.
   */
  readonly testId?: string;
}

export function WaitingIndicator({
  label,
  className,
  testId = "waiting-indicator",
}: WaitingIndicatorProps) {
  return (
    <p
      data-testid={testId}
      role="status"
      className={cn(
        "flex items-center justify-center gap-1.5 text-center text-sm font-semibold text-amber-300",
        className
      )}
    >
      {/* A pulsing dot marks this as live state, not a static caption.
          It carries no information of its own, so it is hidden from
          assistive tech and stopped by the reduced-motion rule that
          already governs .animate-pulse. */}
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
      />
      <span>
        {/* The label and the dots are read as one phrase: the visible
            dots are decorative, so the text carries its own "…". */}
        <span>{label}</span>
        <span className="sr-only">…</span>
        <AnimatedEllipsis />
      </span>
    </p>
  );
}
