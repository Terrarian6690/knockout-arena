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
 * Resolve a module specifier FROM a given client file to an absolute path
 * (no extension). Bare package imports (react, clsx, …) resolve to
 * node_modules — outside both the client and the engine — and are fine.
 * The "@/" alias maps to src/.
 *
 * Resolution (not string matching) is essential: the client now has a
 * `components/game/` directory whose modules are addressed as
 * "../game/MultiplayerGame" from the lobby — those are LOCAL client
 * modules, not deep engine imports, and the guard must tell them apart
 * from the engine package directory (src/game).
 */
function resolveSpecifier(fromFile: string, spec: string): string {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) {
    return path.join(clientDir, "..", "node_modules", spec);
  }
  const base = spec.startsWith("@/")
    ? path.join(clientDir, "..", spec.slice(2))
    : spec;
  return path.resolve(path.dirname(fromFile), base);
}

/** Is `target` inside the directory `dir`? */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * If the specifier (imported from `fromFile`) references the ENGINE
 * package directory (src/game), return the deep suffix ("" for the
 * barrel itself); otherwise null.
 */
function engineImportSuffix(fromFile: string, spec: string): string | null {
  const engineDir = path.join(clientDir, "..", "game");
  const resolved = resolveSpecifier(fromFile, spec);
  if (resolved !== engineDir && !isInside(engineDir, resolved)) return null;
  const suffix = path.relative(engineDir, resolved);
  if (suffix === "" || suffix === ".") return "";
  // "index"/"index.ts" are explicit barrel forms; anything else is deep.
  return suffix.replace(/\.ts(x)?$/, "");
}

/**
 * Does the specifier (imported from `fromFile`) reference the SERVER
 * package directory (src/server)? Resolution-based for the same reason.
 */
function isServerImport(fromFile: string, spec: string): boolean {
  const serverDir = path.join(clientDir, "..", "server");
  return isInside(serverDir, resolveSpecifier(fromFile, spec));
}

describe("client / engine boundary", () => {
  const files = clientSourceFiles(clientDir);

  it("has client files to guard (sanity)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => path.relative(clientDir, f)))(
    "client module %s imports the engine only via the public barrel",
    (relFile) => {
      const file = path.join(clientDir, relFile);
      const source = readFileSync(file, "utf8");
      const engineImports = importSpecifiers(source)
        .map((spec) => engineImportSuffix(file, spec))
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
    const file = path.join(clientDir, "useGame.ts");
    expect(specs.some((s) => engineImportSuffix(file, s) === "")).toBe(true);
  });

  it("the local components/game folder is NOT the engine (sanity)", () => {
    const file = path.join(clientDir, "components", "lobby", "Lobby.tsx");
    expect(engineImportSuffix(file, "../game/MultiplayerGame")).toBeNull();
    expect(
      engineImportSuffix(file, "../../../game")
    ).toBe("");
  });
});

describe("client / server boundary", () => {
  const files = clientSourceFiles(clientDir);

  it("has client files to guard (sanity)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => path.relative(clientDir, f)))(
    "client module %s never imports server code",
    (relFile) => {
      const file = path.join(clientDir, relFile);
      const source = readFileSync(file, "utf8");
      const serverImports = importSpecifiers(source).filter((spec) =>
        isServerImport(file, spec)
      );
      // Server code must never enter the browser bundle: each side of the
      // wire protocol owns its own end of the contract (mirroring
      // src/server/protocol.ts), and only Node-side tests may cross this
      // line (they live in __tests__, excluded from this scan).
      expect(
        serverImports,
        `${relFile} must not import src/server — server code must stay out ` +
          `of the browser bundle (client tests are excluded from this rule)`
      ).toEqual([]);
    }
  );

  it("the network client exists and stays off the server (sanity)", () => {
    const source = readFileSync(
      path.join(clientDir, "network", "websocketClient.ts"),
      "utf8"
    );
    expect(source).toContain("createNetworkClient");
    expect(importSpecifiers(source)).toContain("./protocolClient");
  });
});
