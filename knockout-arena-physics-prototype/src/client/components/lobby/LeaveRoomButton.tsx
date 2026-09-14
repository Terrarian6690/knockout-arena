import { cn } from "../../utils/cn";

/**
 * The leave-room affordance (Task 27): a red, icon-only exit button
 * pinned to the screen's top-left corner, between the room panel and the
 * screen edge.
 *
 * Presentation only. It calls exactly the same `onLeave` the panel's
 * "Leave Room" text button used to call — the same network client
 * leaveRoom(), the same leave_room frame, the same server-side seat
 * release. Nothing about what leaving DOES changed with this task.
 *
 * Design notes:
 *   - the colour is the design system's existing danger family
 *     (red-300/400/500, already used by the error banner, the eliminated
 *     seat state and the disconnected seat dot) rather than a new red;
 *   - the icon is a door with an arrow pointing OUT of it — the
 *     conventional "exit/leave" glyph, which reads as escape without
 *     needing a label beside it;
 *   - it is icon-only, so it carries a real accessible name via
 *     aria-label plus a title tooltip for sighted mouse users. The label
 *     stays "Leave Room", the exact wording the button had before, so
 *     assistive-technology users hear no change in meaning.
 */
export function LeaveRoomButton({
  onLeave,
  className,
  testId = "leave-room",
  label = "Leave Room",
}: {
  onLeave: () => void;
  /** Extra positioning classes from the screen that places it. */
  className?: string;
  /**
   * The screen placing it keeps its own test id, so the existing
   * lifecycle coverage on each screen keeps pointing at the same action.
   */
  testId?: string;
  /** The accessible name — an icon-only button must always have one. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onLeave}
      data-testid={testId}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
        // The danger palette, at rest: legible but not shouting.
        "border border-red-400/30 bg-red-500/10 text-red-300",
        // …and unmistakably destructive on approach.
        "transition-colors hover:border-red-400/60 hover:bg-red-500/20 hover:text-red-200",
        "active:scale-95",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300/80",
        className
      )}
    >
      <ExitIcon />
    </button>
  );
}

/**
 * Door-with-outbound-arrow. `aria-hidden` because the button itself
 * carries the accessible name — announcing both would be a stutter.
 */
function ExitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The door frame, open on the side the arrow leaves through. */}
      <path d="M15 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h9" />
      {/* The arrow heading out. */}
      <path d="M11 12h10" />
      <path d="m18 8 4 4-4 4" />
    </svg>
  );
}
