import { PLAYER_COLORS } from "../../../game";

/**
 * Disc-skin choices — the cosmetic look of a player's pawn.
 *
 * A skin is a palette index into the engine's PLAYER_COLORS (the same
 * palette the renderer paints pawns with), so what the picker shows is
 * EXACTLY what appears on the board, on every roster and on every
 * player list.
 *
 * THE DEFAULT IS RANDOM: a player who has not picked a color enters the
 * lobby with a skin DEALT BY THE SERVER at seating time — drawn from
 * this same palette, excluding whatever the players already seated are
 * wearing. Until you join a room (or a public game) your skin is simply
 * unknown, and the picker shows the "Random" choice. Picking a color
 * here makes it explicit instead (the server only honors it while the
 * room is in the lobby); picking "Random" hands the decision back.
 */
export const DEFAULT_SKIN = 0; // the palette's orange (fallback only)

/** A picker choice: a concrete palette index, or null = "Random". */
export type SkinChoice = number | null;

/** Human-friendly names, index-aligned with PLAYER_COLORS. */
export const SKIN_NAMES: readonly string[] = [
  "Orange",
  "Cyan",
  "Red",
  "Green",
  "Yellow",
  "Violet",
];

export const RANDOM_SKIN_NAME = "Random";

export function skinName(index: SkinChoice): string {
  if (index === null) return RANDOM_SKIN_NAME;
  return SKIN_NAMES[index] ?? `Skin ${index + 1}`;
}

/** The six concrete skins, as picker-friendly pairs. */
export function skinChoices(): ReadonlyArray<{
  index: number;
  name: string;
  color: string;
}> {
  return PLAYER_COLORS.map((color, index) => ({
    index,
    name: skinName(index),
    color,
  }));
}

const STORAGE_KEY = "knockout-arena.skin";

/**
 * The locally persisted EXPLICIT skin choice, or null when the player
 * wants (or has never left) the random default. Anything unreadable or
 * out of range counts as "no choice" — the stored value is a
 * convenience, never a source of truth (the server deals the real one).
 */
export function loadSkinPreference(): SkinChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null; // no explicit choice → random
    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value >= PLAYER_COLORS.length
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Persist the explicit choice; `null` clears it (back to the random
 * default). Storage failures are silently cosmetic.
 */
export function saveSkinPreference(skin: SkinChoice): void {
  try {
    if (skin === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(skin));
  } catch {
    // Private mode / disabled storage: the pick still works this session.
  }
}
