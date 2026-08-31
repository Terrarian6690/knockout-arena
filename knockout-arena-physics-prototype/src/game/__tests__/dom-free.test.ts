import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architectural guard: the engine (everything in src/game/ except useGame.ts)
 * must stay DOM-free / headless so the same code can later run in a
 * server-authoritative simulation. useGame.ts is the client/UI boundary and
 * the ONLY module allowed to touch browser APIs.
 */

const gameDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const allFiles = readdirSync(gameDir).filter((f) => f.endsWith(".ts"));
const engineFiles = allFiles.filter((f) => f !== "useGame.ts" && !f.startsWith("__tests__"));
const CLIENT_ONLY_FILE = "useGame.ts";

/** Browser-global usage patterns that must not appear in engine sources. */
const DOM_PATTERNS: Array<[RegExp, string]> = [
  [/\bwindow\./, "window"],
  [/\bdocument\./, "document"],
  [/\brequestAnimationFrame\b/, "requestAnimationFrame"],
  [/\bcancelAnimationFrame\b/, "cancelAnimationFrame"],
  [/\bnavigator\./, "navigator"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bHTMLCanvasElement\b/, "HTMLCanvasElement"],
];

describe("engine / UI boundary", () => {
  it("has engine files to guard (sanity)", () => {
    expect(engineFiles.length).toBeGreaterThan(5);
  });

  it("keeps useGame.ts as the single client-side module", () => {
    expect(allFiles).toContain(CLIENT_ONLY_FILE);
  });

  it.each(engineFiles)("engine module %s contains no browser API usage", (file) => {
    const source = readFileSync(path.join(gameDir, file), "utf8");
    for (const [pattern, name] of DOM_PATTERNS) {
      expect(source, `${file} must not use ${name}`).not.toMatch(pattern);
    }
  });

  it.each(engineFiles)("engine module %s does not import React", (file) => {
    const source = readFileSync(path.join(gameDir, file), "utf8");
    expect(source, `${file} must not import react`).not.toMatch(
      /from\s+["']react/
    );
  });

  it("no engine module imports the client hook (no reverse dependency)", () => {
    for (const file of engineFiles) {
      const source = readFileSync(path.join(gameDir, file), "utf8");
      expect(source, `${file} must not import useGame`).not.toMatch(
        /useGame/
      );
    }
  });

  it("the engine directory is importable without a DOM (this suite runs in node)", () => {
    // Self-evident: every other test file in this directory imports and
    // exercises the engine under environment "node". Kept as an explicit
    // marker so a future accidental `environment: jsdom` default is visible.
    expect(typeof globalThis.window).toBe("undefined");
  });
});
