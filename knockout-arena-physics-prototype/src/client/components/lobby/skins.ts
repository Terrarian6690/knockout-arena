import { PLAYER_COLORS } from "../../../game";

/**
 * Disc-skin choices — the cosmetic look of a player's pawn.
 *
 * A skin is a palette index into the engine's PLAYER_COLORS (the same
 * palette the renderer paints pawns with), so what the picker shows is
 * EXACTLY what appears on the board, on every roster and on every
 * player list. The server owns the final word (set_skin is validated
 * there); this module only mirrors the choice range and persists the
 * local preference.
 */
export const DEFAULT_SKIN = 0; // the palette's orange

/** Human-friendly names, index-aligned with PLAYER_COLORS. */
export const SKIN_NAMES: readonly string[] = [
  "Orange",
  "Cyan",
  "Red",
  "Green",
  "Yellow",
  "Violet",
];

export function skinName(index: number): string {
  return SKIN_NAMES[index] ?? `Skin ${index + 1}`;
}

/** Every selectable skin, as picker-friendly pairs. */
export function skinChoices(): ReadonlyArray<{ index: number; name: string; color: string }> {
  return PLAYER_COLORS.map((color, index) => ({
    index,
    name: skinName(index),
    color,
  }));
}

const STORAGE_KEY = "knockout-arena.skin";

/**
 * The locally persisted skin preference (or the default). Anything
 * unreadable or out of range falls back to the default — the stored
 * value is a convenience, never a source of truth (the server validates
 * the real choice).
 */
export function loadSkinPreference(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SKIN;
    const value = Number(raw);
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value >= PLAYER_COLORS.length
    ) {
      return DEFAULT_SKIN;
    }
    return value;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** Persist the choice; storage failures are silently cosmetic. */
export function saveSkinPreference(skin: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(skin));
  } catch {
    // Private mode / disabled storage: the pick still works this session.
  }
}
