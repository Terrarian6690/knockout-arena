import {
  choosableImageSkins,
  imageSkinById,
  imageSkinFallbackColor,
  isChoosableSkinId,
  isImageSkin,
  PLAYER_COLORS,
  playerColor,
} from "../../../game";
import { imageSkinUrl } from "../../imageSkinAssets";
import type { CSSProperties } from "react";

/**
 * Disc-skin choices — the cosmetic look of a player's pawn.
 *
 * A skin is a palette index into the engine's PLAYER_COLORS (the same
 * palette the renderer paints pawns with), so what the picker shows is
 * EXACTLY what appears on the board, on every roster and on every
 * player list — plus the IMAGE skins at ids 100+ (see game/imageSkins):
 * choosable ones sit in the menu after the palette; SECRET ones (bound
 * to name triggers) are assigned by the server alone and never listed.
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
  const image = imageSkinById(index);
  if (image !== null) return image.name;
  return SKIN_NAMES[index] ?? `Skin ${index + 1}`;
}

/** The six concrete skins, as picker-friendly pairs. */
export function skinChoices(): ReadonlyArray<{
  index: number;
  name: string;
  color: string;
}> {
  return [
    ...PLAYER_COLORS.map((color, index) => ({
      index,
      name: skinName(index),
      color,
    })),
    // The choosable IMAGE skins, after the palette. Secrets never list.
    ...choosableImageSkins().map((def) => ({
      index: def.id,
      name: def.name,
      color: imageSkinFallbackColor(def.id),
    })),
  ];
}

/**
 * The CSS style for a circular swatch of any skin id: palette skins are
 * a flat color; image skins layer the bundled asset over the same
 * fallback color with `cover` centering — on a round element that is
 * exactly the largest centered circle the image can give (any input
 * aspect ratio, nothing squashed).
 */
export function skinSwatchStyle(index: number): CSSProperties {
  const style: CSSProperties = {
    backgroundColor: playerColor(index),
  };
  const url = isImageSkin(index) ? imageSkinUrl(index) : null;
  if (url !== null) {
    style.backgroundImage = `url(${url})`;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
  }
  return style;
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
      !(value >= 0 && value < PLAYER_COLORS.length) &&
      !isChoosableSkinId(value)
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
