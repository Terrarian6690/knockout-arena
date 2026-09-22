/**
 * PHONE BROWSERS ONLY: reclaiming the screen from the browser chrome.
 *
 * On a phone the address bar eats a meaningful slice of an already
 * small display, and the arena is the one thing that must own it.
 * Browsers hide that chrome in fullscreen mode — but fullscreen may
 * only be REQUESTED from a user gesture, which a phase flip on the
 * wire never is. So the contract is: the first touch anywhere inside
 * the match screen (aim tap, power, Confirm) is the gesture that asks
 * for fullscreen with `navigationUI: "hide"` — one time per mounted
 * match screen, phones only (coarse pointers), and leaving the match
 * screen hands the chrome back.
 *
 * Everything is feature-detected and failure-swallowing: desktops and
 * browsers without the API are untouched, and a refused request (user
 * permission, kiosk policy) must never break input — the game is fully
 * playable with the bar still up.
 */

/** Coarse pointer = touch-first device (phones, tablets). */
export function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * Enter fullscreen on a phone. Resolves to whether the browser is now
 * (or already was) fullscreen; never throws.
 */
export async function enterMobileFullscreen(): Promise<boolean> {
  if (!isCoarsePointer() || typeof document === "undefined") return false;
  const element = document.documentElement;
  if (typeof element.requestFullscreen !== "function") return false;
  if (document.fullscreenEnabled === false) return false;
  if (document.fullscreenElement) return true;
  try {
    await element.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    return false;
  }
}

/** Leave fullscreen (no-op when not in one). Never throws. */
export function exitMobileFullscreen(): void {
  if (typeof document === "undefined" || !document.fullscreenElement) return;
  try {
    const result = document.exitFullscreen();
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // Fullscreen is a presentation nicety — never a failure path.
  }
}
