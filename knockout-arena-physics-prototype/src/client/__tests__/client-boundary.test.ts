import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Client → engine boundary guard.
 *
 * The React client (src/client) may only consume the engine through its
 * public entry point (src/game/index.ts) — exactly the same surface a
 * future authoritative server will use. Deep imports of engine internals
 * (`../game/state`, `../game/physics`, …) would couple the client to
 * implementation details and are rejected here.
 *
 * This suite only reads files (no DOM needed), so it runs in the same node
 * environment as the engine tests.
 */

const clientDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** All client source files (.ts/.tsx), excluding this test directory. */
function clientSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...clientSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** All module specifiers referenced by a source file. */
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

/**
 * Does a specifier reference the engine package directory (src/game)?
 * Matches "../game", "../../game", "@/game", "../game/state", …
 */
function engineImportSuffix(spec: string): string | null {
  const m = spec.match(/(?:^|[/@])game(?:\/(.*))?$/);
  if (!m) return null;
  return m[1] ?? "";
}

describe("client / engine boundary", () => {
  const files = clientSourceFiles(clientDir);

  it("has client files to guard (sanity)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => path.relative(clientDir, f)))(
    "client module %s imports the engine only via the public barrel",
    (relFile) => {
      const source = readFileSync(path.join(clientDir, relFile), "utf8");
      const engineImports = importSpecifiers(source)
        .map(engineImportSuffix)
        .filter((s): s is string => s !== null);
      // Every engine reference must resolve to the entry point itself
      // ("" → "../game") or its explicit index form — never a deep module.
      for (const suffix of engineImports) {
        expect(
          suffix === "" || suffix === "index" || suffix === "index.ts",
          `${relFile} must not deep-import the engine ("${suffix}") — ` +
            `import from the public barrel "../game" instead`
        ).toBe(true);
      }
    }
  );

  it("the client actually consumes the engine (sanity — not fully decoupled)", () => {
    const useGame = readFileSync(path.join(clientDir, "useGame.ts"), "utf8");
    const specs = importSpecifiers(useGame);
    expect(specs.some((s) => engineImportSuffix(s) === "")).toBe(true);
  });
});
