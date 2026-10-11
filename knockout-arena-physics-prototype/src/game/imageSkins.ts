/**
 * IMAGE-BASED DISC SKINS — the data contract shared by the client
 * (picker, swatches, renderer) and the server (validation, the SECRET
 * name-trigger assignment).
 *
 * Ids live at 100+ so they can ride the SAME wire field as the palette
 * indices (0..5): a skin is still just a number end to end, and every
 * existing consumer keeps working — unknown/big ids degrade to a
 * wrapped palette color wherever a color is needed (see
 * imageSkinFallbackColor and playerColor's wrapping).
 *
 * CHOOSABLE vs SECRET: a skin with `trigger: null` is a normal picker
 * choice (the player may set it with set_skin). A skin with a trigger
 * is SECRET: it is never listed anywhere, set_skin rejects it exactly
 * like an invalid id (no existence leak), and the SERVER alone assigns
 * it — automatically, to any seat whose display name contains the
 * trigger (case-insensitive). The first matching trigger in list order
 * wins.
 *
 * DISPLAY CROP CONTRACT (client): every asset is shown as the LARGEST
 * CENTERED CIRCLE that fits the image — concretely: the centered square
 * of the shorter side, clipped to a circle. All render paths implement
 * exactly that (CSS round element + background-size:cover;
 * preserveAspectRatio "xMidYMid slice" inside a circle clip in SVG; the
 * centered-square drawImage source rect inside a canvas clip), so any
 * input aspect ratio — huge wallpaper, tall photo, tiny icon — crops
 * correctly with nothing ever squashed.
 */

/** Image skins start here; palette indices stay 0..5. */
import { PLAYER_COLORS } from "./player";

export const IMAGE_SKIN_BASE = 100;

export interface ImageSkinDef {
  /** Wire id (≥ IMAGE_SKIN_BASE). */
  readonly id: number;
  /** Bundled asset file name, without extension (client resolves it). */
  readonly asset: string;
  /** Human-friendly name (picker/aria; secrets never show it). */
  readonly name: string;
  /**
   * The secret name-trigger, or null for a normally choosable skin.
   * Matched case-insensitively as a SUBSTRING of the display name.
   */
  readonly trigger: string | null;
}

export const IMAGE_SKINS: readonly ImageSkinDef[] = [
  { id: 100, asset: "czarna-dziura", name: "Black hole", trigger: null },
  { id: 101, asset: "troll-face", name: "Troll", trigger: "lol" },
  { id: 102, asset: "moai", name: "Moai", trigger: "sigm" },
  { id: 103, asset: "anime-girl", name: "Anime girl", trigger: "tyru" },
];

export function isImageSkin(id: number): boolean {
  return (
    Number.isInteger(id) &&
    id >= IMAGE_SKIN_BASE &&
    id < IMAGE_SKIN_BASE + IMAGE_SKINS.length
  );
}

export function imageSkinById(id: number): ImageSkinDef | null {
  return IMAGE_SKINS.find((def) => def.id === id) ?? null;
}

/** The image skins a player may pick in the wardrobe. */
export function choosableImageSkins(): ReadonlyArray<ImageSkinDef> {
  return IMAGE_SKINS.filter((def) => def.trigger === null);
}

/** Whether set_skin may set this id (palette range or choosable image). */
export function isChoosableSkinId(id: number): boolean {
  return Number.isInteger(id) && choosableImageSkins().some((d) => d.id === id);
}

function isSecretSkin(id: number): boolean {
  return isImageSkin(id) && imageSkinById(id)!.trigger !== null;
}

/**
 * The secret skin a display name earns, or null. Case-insensitive
 * substring match; LIST ORDER is the priority (first hit wins).
 */
export function secretSkinForName(name: string): number | null {
  const lowered = name.toLowerCase();
  for (const def of IMAGE_SKINS) {
    if (def.trigger !== null && lowered.includes(def.trigger)) return def.id;
  }
  return null;
}

export { isSecretSkin };

/**
 * The palette color anything image-skinned falls back to (rings, aim
 * arrows, not-yet-loaded assets): the id wraps into the palette
 * deterministically, so 100..105 map onto 0..5.
 */
export function imageSkinFallbackColor(id: number): string {
  const i =
    ((id % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length;
  return PLAYER_COLORS[i]!;
}
