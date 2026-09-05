/**
 * Player-facing room codes — client-side helpers.
 *
 * Mirrors `src/server/roomCode.ts` (the client cannot import server code;
 * like protocol.ts/protocolClient.ts the helpers are duplicated by design).
 *
 * A room code is exactly 4 characters from an alphabet that deliberately
 * excludes the visually ambiguous I, O, 0 and 1, so codes are easy to
 * read, type, share over voice, and remember (e.g. "K7P4", "X9QA").
 *
 * IMPORTANT: a room code is NOT a secret and NOT a credential. It only
 * LOCATES a room — identity and reconnection stay bound to the opaque
 * session/reconnect tokens the server issues, which are unchanged.
 */

/** The code alphabet: uppercase letters and digits minus I, O, 0, 1. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Room codes are exactly this many characters. */
export const ROOM_CODE_LENGTH = 4;

/**
 * Whether `value` is a well-formed room code: exactly 4 characters, all
 * from the allowed alphabet (so already uppercase, no whitespace, none of
 * the excluded ambiguous characters).
 */
export function isValidRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of value) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * Normalize player input into a room code: uppercase it and strip ALL
 * whitespace (leading, trailing, and between characters), then require a
 * well-formed code. Returns the normalized code, or null when the input
 * cannot be a code ("k7 p4" → "K7P4"; "K7P0" / "K7P" → null).
 *
 * The server normalizes joins too (same rules); applying it client-side
 * first just gives the player instant feedback.
 */
export function normalizeRoomCode(input: string): string | null {
  const normalized = input.replace(/\s+/g, "").toUpperCase();
  return isValidRoomCode(normalized) ? normalized : null;
}
