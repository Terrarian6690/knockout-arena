/**
 * Player display names — a purely cosmetic, room-scoped label a player
 * may choose for themselves (see set_name).
 *
 * A display name is NOT an identity: the seat/playerId assignment and
 * the session/reconnect credentials remain the authoritative identity,
 * completely unchanged. Names are not unique — two players may share
 * one — and they never authorize anything. Treat them as untrusted
 * input: the rules below are enforced SERVER-side (the client mirrors
 * them only for instant local feedback).
 *
 * Rules (applied to the trimmed value):
 *   - 1..16 characters (counted in Unicode code points);
 *   - no leading/trailing whitespace (trimmed away on save);
 *   - no control characters (newlines, tabs, C0/C1, DEL…);
 *   - any other Unicode letters, numbers and punctuation are allowed.
 */

/** Maximum display-name length, in Unicode code points. */
export const MAX_DISPLAY_NAME_LENGTH = 16;

/** Any Unicode control character (C0, C1, DEL — the Cc category). */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Validate and normalize a requested display name. Returns the trimmed,
 * valid name, or null when the input cannot be a display name (empty
 * after trimming, longer than MAX_DISPLAY_NAME_LENGTH code points, or
 * containing control characters).
 */
export function normalizeDisplayName(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (Array.from(trimmed).length > MAX_DISPLAY_NAME_LENGTH) return null;
  if (CONTROL_CHARACTER.test(trimmed)) return null;
  return trimmed;
}
