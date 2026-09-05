import { randomInt } from "node:crypto";

/**
 * Player-facing room codes — a short, human-friendly locator for a room.
 *
 * A room code is exactly 4 characters from an alphabet that deliberately
 * excludes the visually ambiguous I, O, 0 and 1, so codes are easy to read,
 * type, share over voice, and remember (e.g. "K7P4", "X9QA").
 *
 * IMPORTANT: a room code is NOT a secret and NOT a credential. It only
 * LOCATES a room — joining still goes through the normal room rules
 * (capacity, waiting state), and identity/reconnection remain bound to the
 * opaque session tokens and reconnect credentials, which are unchanged.
 * With 32^4 ≈ 1M combinations, the code is a convenience, not a lock.
 */

/** The code alphabet: uppercase letters and digits minus I, O, 0, 1. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Room codes are exactly this many characters. */
export const ROOM_CODE_LENGTH = 4;

/** Maximum generation attempts before giving up (defense-in-depth only). */
const MAX_GENERATION_ATTEMPTS = 1_000;

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
 */
export function normalizeRoomCode(input: string): string | null {
  const normalized = input.replace(/\s+/g, "").toUpperCase();
  return isValidRoomCode(normalized) ? normalized : null;
}

/**
 * Generate a fresh random room code. Uniform over the alphabet (crypto
 * randomInt — never sequential, never predictable). Uniqueness among
 * ACTIVE rooms is enforced by the caller (the room manager), not here.
 */
export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Generate a room code that is not already in use among active rooms.
 * Collisions (possible with ~1M combinations) simply trigger another
 * random attempt. `factory` is injectable so tests can drive collisions
 * deterministically; it should return a candidate code (the manager
 * re-asks until the candidate is free).
 */
export function generateUniqueRoomCode(
  isTaken: (code: string) => boolean,
  factory: () => string = generateRoomCode
): string {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const candidate = factory();
    if (!isTaken(candidate)) return candidate;
  }
  // Unreachable in practice (needs ~1M active rooms); fail loudly rather
  // than loop forever.
  throw new Error(
    "roomCode: could not generate a unique room code (alphabet exhausted?)"
  );
}
