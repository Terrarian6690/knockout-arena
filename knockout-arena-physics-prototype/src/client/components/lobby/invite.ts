import { normalizeRoomCode } from "../../network/roomCode";

/**
 * Room invites and join-code prefill — client-side helpers.
 *
 * An invite is just a locator, like the room code itself: a URL carrying
 * `?room=CODE` that opens the lobby with the Join input prefilled. It is
 * NOT a credential — identity and reconnection stay on the server-issued
 * session/reconnect tokens, unchanged. The lobby never auto-joins from
 * the query string; the player always presses Join Room themselves.
 *
 * Every window-bound helper here is total: invalid or missing query
 * parameters (and non-browser environments) degrade to null/empty/false
 * instead of throwing, so a bad link can never break the lobby.
 */

/**
 * Build the invite URL for a room code: the current origin plus
 * `?room=CODE` (e.g. `https://arena.example/?room=K7P4`).
 */
export function buildInviteUrl(origin: string, roomCode: string): string {
  return `${origin}/?room=${roomCode}`;
}

/**
 * The invite URL for a room code from the live page, or null when the
 * origin is unavailable (non-browser environment, opaque origin).
 */
export function getInviteUrl(roomCode: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    const origin = window.location?.origin;
    if (typeof origin !== "string" || origin === "" || origin === "null") {
      return null;
    }
    return buildInviteUrl(origin, roomCode);
  } catch {
    return null;
  }
}

/**
 * Parse `?room=CODE` out of a query string: the first `room` param,
 * normalized with the same rules as the Join input (uppercase, all
 * whitespace stripped, well-formed alphabet). Returns the normalized
 * code, or null for a missing/invalid param — never throws.
 */
export function getRoomCodeQuery(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get("room");
    if (raw === null) return null;
    return normalizeRoomCode(raw);
  } catch {
    return null;
  }
}

/**
 * The Join input's initial value from the live page's query string: the
 * normalized `?room=CODE`, or "" when absent/invalid/unavailable.
 */
export function getPrefillJoinCode(): string {
  try {
    if (typeof window === "undefined") return "";
    return getRoomCodeQuery(window.location.search) ?? "";
  } catch {
    return "";
  }
}

/**
 * Copy text to the clipboard. Prefers the async Clipboard API; on its
 * absence (plain-http previews) OR its rejection (embedded iframe
 * without clipboard-write permission) falls back to the legacy
 * execCommand path, which works inside a real user click. Returns
 * whether the copy succeeded — callers must never claim success on
 * false. Total: never throws, even outside a browser.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / not allowed — try the legacy path below.
  }
  try {
    if (typeof document === "undefined") return false;
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(helper);
    return copied;
  } catch {
    return false;
  }
}
