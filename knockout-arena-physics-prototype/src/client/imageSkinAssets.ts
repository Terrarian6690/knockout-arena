/**
 * The bundled URLs of the image-skin assets, keyed by asset name.
 *
 * Imported statically so Vite inlines them into the single-file bundle
 * (the server serves exactly one document — anything else is a 404).
 * Every image skin needs its URL client-side, choosable or NOT: a
 * player WEARING a secret skin must see it (and be seen) on the board,
 * in the roster and in the lobby — only the picker hides secrets.
 */
import czarnaDziura from "./assets/skins/czarna-dziura.jpg";
import trollFace from "./assets/skins/troll-face.png";
import moai from "./assets/skins/moai.png";
import animeGirl from "./assets/skins/anime-girl.png";
import { imageSkinById } from "../game";

const URLS_BY_ASSET: Readonly<Record<string, string>> = {
  "czarna-dziura": czarnaDziura,
  "troll-face": trollFace,
  moai: moai,
  "anime-girl": animeGirl,
};

/** The bundled URL for an image skin id, or null when unknown. */
export function imageSkinUrl(id: number): string | null {
  const def = imageSkinById(id);
  if (def === null) return null;
  return URLS_BY_ASSET[def.asset] ?? null;
}
