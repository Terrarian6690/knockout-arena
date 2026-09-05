/**
 * Player display names — client-side helper.
 *
 * Mirrors `src/server/displayName.ts` (the client cannot import server
 * code; same duplication pattern as protocol/protocolClient and
 * roomCode). The SERVER enforces these rules for real; applying them
 * client-side first just gives the player instant feedback.
 */

/** Maximum display-name length, in Unicode code points. */
export const MAX_DISPLAY_NAME_LENGTH = 16;

/**
 * Validate and normalize a display name: trimmed, 1..16 Unicode code
 * points, no control characters. Returns the normalized name, or null
 * when the input cannot be a display name.
 */
export function normalizeDisplayName(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (Array.from(trimmed).length > MAX_DISPLAY_NAME_LENGTH) return null;
  if (/\p{Cc}/u.test(trimmed)) return null;
  return trimmed;
}
