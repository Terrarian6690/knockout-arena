import { useEffect, type RefObject } from "react";

/**
 * Modal focus management (Task 11) — presentation only. Nothing here
 * reads or influences the match verdict; it moves keyboard focus so the
 * result overlay behaves like a real dialog.
 *
 * Two concerns, deliberately kept apart from the Task 9 live region:
 *
 *   - FOCUS: on mount, focus moves into the dialog; on unmount it goes
 *     back where it came from.
 *   - ANNOUNCEMENT: unchanged, still published by the overlay's own
 *     post-mount effect into its own live region.
 *
 * They never touch each other: everything below works through refs and
 * direct DOM calls, so it triggers no React state update and therefore
 * cannot re-run, delay or duplicate the announcement effect.
 */

/**
 * Elements that take sequential (Tab) focus. `tabindex="-1"` is excluded
 * on purpose: the dialog container itself is programmatically focusable
 * but must not be a Tab stop.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[tabindex]",
].join(",");

/**
 * The dialog's tabbable descendants, in DOM order.
 *
 * jsdom performs no layout, so geometric visibility tests (offsetParent,
 * client rects) are meaningless there; this filters on the attributes
 * that actually decide tabbability and that tests can rely on.
 */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  const found = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return found.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.hasAttribute("hidden")) return false;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) < 0) return false;
    return true;
  });
}

/**
 * Which element should receive focus when the dialog closes.
 *
 * Both candidates are captured when the dialog OPENS, because by the
 * time React runs an unmount cleanup the component's refs are already
 * null and the browser has already dropped focus to <body>. A candidate
 * is only usable if it is still in the document: the element that had
 * focus before a match ended is frequently gone by the time the overlay
 * closes (the match controls unmount with the running match), which is
 * exactly why a fallback exists.
 */
export function pickRestoreTarget(
  previous: HTMLElement | null,
  fallback: HTMLElement | null
): HTMLElement | null {
  if (previous !== null && previous.isConnected) return previous;
  if (fallback !== null && fallback.isConnected) return fallback;
  return null;
}

/**
 * Move focus into `ref` on mount and put it back on unmount.
 *
 * The container itself is focused rather than its action button: a
 * screen reader then reads the dialog (its label and description — the
 * actual result) instead of jumping straight to "Back to lobby" and
 * skipping what happened.
 *
 * `getFallback` is read once, at mount, for the reason described above.
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  getFallback?: () => HTMLElement | null
): void {
  useEffect(() => {
    const container = ref.current;
    if (container === null) return;

    // Captured now — neither survives until the cleanup runs.
    const active = document.activeElement;
    const previous =
      active instanceof HTMLElement && active !== document.body ? active : null;
    const fallback = getFallback?.() ?? null;

    container.focus();

    return () => {
      // Only reclaim focus that is ours to move: either it is still
      // inside the (now detached) dialog, or the browser has already
      // dropped it to <body> because the dialog was removed. Focus the
      // user moved somewhere else entirely is left alone.
      const current = document.activeElement;
      const ours =
        current === null ||
        current === document.body ||
        container.contains(current);
      if (!ours) return;

      pickRestoreTarget(previous, fallback)?.focus();
    };
    // Mount/unmount only: re-running this would re-steal focus on every
    // re-render a finished match receives (snapshots keep arriving).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}

/**
 * Keep Tab inside the dialog: Tab past the last focusable element wraps
 * to the first, Shift+Tab before the first wraps to the last.
 *
 * Containment is implemented on keydown rather than by mutating the
 * background (no `inert`, no aria-hidden sweep), so the live regions
 * outside this dialog keep working exactly as they did.
 */
export function handleTrapKeyDown(
  event: Pick<KeyboardEvent, "key" | "shiftKey"> & { preventDefault(): void },
  container: HTMLElement | null
): void {
  if (event.key !== "Tab" || container === null) return;

  const items = focusableWithin(container);
  if (items.length === 0) {
    // Nothing to land on — keep focus on the dialog itself.
    event.preventDefault();
    container.focus();
    return;
  }

  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && container.contains(active);

  if (event.shiftKey) {
    if (!inside || active === first || active === container) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  // `active === container` is handled explicitly rather than left to
  // native sequential navigation: the container is where focus starts,
  // so this is the very first Tab a keyboard user presses.
  if (!inside || active === last || active === container) {
    event.preventDefault();
    first.focus();
  }
}
