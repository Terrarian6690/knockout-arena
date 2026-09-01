import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architectural guard: the engine (everything in src/game) must stay
 * DOM-free / headless so the same code can later run in a server-
 * authoritative simulation.
 *
 * Since the client/UI code moved to src/client (useGame.ts, renderer.ts and
 * the React components), src/game is a PURE engine package:
 *   - no browser globals, no React;
 *   - fully self-contained — engine modules may only import other engine
 *     modules (relative "./…") and matter-js, the engine's single external
 *     dependency. Importing anything from src/client (or any other package)
 *     fails the build here, so a future server that imports src/game can
 *     never pull in React, Vite or UI code.
 */

const gameDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoSrcDir = path.dirname(gameDir);
const clientDir = path.join(repoSrcDir, "client");

const allFiles = readdirSync(gameDir).filter((f) => f.endsWith(".ts"));
const engineFiles = allFiles.filter((f) => !f.startsWith("__tests__"));

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

/**
 * All module specifiers referenced by a source file: static imports,
 * re-exports, side-effect imports and dynamic imports.
 */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

describe("engine / UI boundary", () => {
  it("has engine files to guard (sanity)", () => {
    expect(engineFiles.length).toBeGreaterThan(5);
  });

  it("contains no client-side modules — the client lives in src/client", () => {
    // UPDATED for the package boundary: useGame.ts and renderer.ts used to
    // live inside src/game behind a whitelist; they moved to src/client so
    // the engine directory is pure simulation code. This replaces the old
    // "useGame.ts is the single client-side module in src/game" assertion
    // with the stronger "no client modules at all in src/game".
    expect(engineFiles).not.toContain("useGame.ts");
    expect(engineFiles).not.toContain("renderer.ts");
    expect(existsSync(path.join(clientDir, "useGame.ts"))).toBe(true);
    expect(existsSync(path.join(clientDir, "renderer.ts"))).toBe(true);
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

  it.each(engineFiles)(
    "engine module %s only imports engine-internal modules and matter-js",
    (file) => {
      const source = readFileSync(path.join(gameDir, file), "utf8");
      for (const spec of importSpecifiers(source)) {
        const ok =
          spec === "matter-js" || // the engine's only external dependency
          spec.startsWith("./"); // a sibling module inside src/game
        expect(
          ok,
          `${file} must not import "${spec}" — engine modules may only ` +
            `import from src/game itself (matter-js is the sole allowed ` +
            `external dependency)`
        ).toBe(true);
      }
    }
  );

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
