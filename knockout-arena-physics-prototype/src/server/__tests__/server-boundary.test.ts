import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as engine from "../../game";

/**
 * Architectural guard for the server package (src/server).
 *
 * The server must stay:
 *   - HEADLESS: no DOM/browser APIs (it may run in any Node process);
 *   - free of React/UI code (src/client is never imported);
 *   - coupled to the engine ONLY through its public barrel (../game) —
 *     no deep engine modules, no direct matter-js usage;
 *   - networked ONLY in the transport adapter: webSocketTransport.ts may
 *     import ws and nothing else from the networking world, while every
 *     gameplay-bearing module (session, gameHost, roomManager, gameServer)
 *     stays transport-free — the engine and GameHost remain unaware that
 *     WebSockets exist (GUARD UPDATED when the transport milestone landed:
 *     the previous blanket "no networking anywhere" policy was replaced by
 *     this stricter split, not weakened);
 *   - free of gameplay duplication: room/session/transport modules drive
 *     the game only through GameHost, never createGame/matter-js;
 *   - transport modules talk ONLY to server APIs (never the engine barrel).
 *
 * Mirrors src/game/__tests__/dom-free.test.ts and
 * src/client/__tests__/client-boundary.test.ts; file-scan only, so it runs
 * in the same node environment as everything else.
 */

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** All server source files (.ts), excluding this test directory. */
function serverSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...serverSourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
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

/** Suffix after "game" if the specifier references the engine directory. */
function engineImportSuffix(spec: string): string | null {
  const m = spec.match(/(?:^|[/@])game(?:\/(.*))?$/);
  return m ? (m[1] ?? "") : null;
}

const DOM_PATTERNS: Array<[RegExp, string]> = [
  [/\bwindow\./, "window"],
  [/\bdocument\./, "document"],
  [/\brequestAnimationFrame\b/, "requestAnimationFrame"],
  [/\bcancelAnimationFrame\b/, "cancelAnimationFrame"],
  [/\bnavigator\./, "navigator"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bHTMLCanvasElement\b/, "HTMLCanvasElement"],
];

/** Networking modules the gameplay-bearing server must not touch. */
const FORBIDDEN_MODULE_PATTERN =
  /^(?:node:)?(?:http|https|http2|net|dgram|tls|dns|child_process|cluster|ws|socket\.io|engine\.io|express|fastify|cors|uws|mqtt|amqplib)$/;
/** The transport adapter additionally must not use anything but plain ws. */
const TRANSPORT_FORBIDDEN_MODULE_PATTERN =
  /^(?:node:)?(?:http|https|http2|net|dgram|tls|dns|child_process|cluster|socket\.io|engine\.io|express|fastify|cors|uws|mqtt|amqplib)$/;

const files = serverSourceFiles(serverDir);
/** Server modules that manage rooms/sessions — everything but the host. */
const roomManagementFiles = files.filter(
  (f) => path.basename(f) !== "gameHost.ts"
);
/** The transport adapter + wire protocol — the only networked modules. */
const transportFiles = files.filter((f) =>
  /^(?:webSocketTransport|protocol)\.ts$/.test(path.basename(f))
);
/** Gameplay-bearing modules: everything except the transport adapter. */
const nonTransportFiles = files.filter(
  (f) => path.basename(f) !== "webSocketTransport.ts"
);
/** The engine package directory (for the unawareness guard). */
const gameDir = path.join(path.dirname(serverDir), "game");
const engineFiles = readdirSync(gameDir).filter((f) => f.endsWith(".ts"));

describe("server package boundary", () => {
  it("has server files to guard (sanity)", () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it.each(files.map((f) => path.relative(serverDir, f)))(
    "server module %s contains no browser API usage",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      for (const [pattern, name] of DOM_PATTERNS) {
        expect(source, `${relFile} must not use ${name}`).not.toMatch(pattern);
      }
    }
  );

  it.each(files.map((f) => path.relative(serverDir, f)))(
    "server module %s imports no React and no client code",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      const specs = importSpecifiers(source);
      for (const spec of specs) {
        expect(
          spec !== "react" && spec !== "react-dom",
          `${relFile} must not import ${spec}`
        ).toBe(true);
        expect(
          !/(?:^|[/@])client(?:\/|$)/.test(spec),
          `${relFile} must not import client code ("${spec}")`
        ).toBe(true);
      }
    }
  );

  it.each(files.map((f) => path.relative(serverDir, f)))(
    "server module %s imports the engine only via the public barrel",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      for (const spec of importSpecifiers(source)) {
        const suffix = engineImportSuffix(spec);
        if (suffix === null) continue; // not an engine import
        expect(
          suffix === "" || suffix === "index" || suffix === "index.ts",
          `${relFile} must not deep-import the engine ("${spec}") — ` +
            `import from the public barrel "../game" instead`
        ).toBe(true);
      }
      // The engine's physics library is engine-internal; the server must
      // not touch Matter.js directly.
      expect(source, `${relFile} must not import matter-js`).not.toMatch(
        /from\s+["']matter-js["']/
      );
    }
  );

  it.each(nonTransportFiles.map((f) => path.relative(serverDir, f)))(
    "gameplay module %s imports no networking (transport stays out of the game)",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      for (const spec of importSpecifiers(source)) {
        expect(
          !FORBIDDEN_MODULE_PATTERN.test(spec),
          `${relFile} must not import "${spec}" — networking belongs to the ` +
            `transport adapter (webSocketTransport.ts) only`
        ).toBe(true);
      }
    }
  );

  it.each(transportFiles.map((f) => path.relative(serverDir, f)))(
    "transport module %s uses plain ws and no other networking",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      for (const spec of importSpecifiers(source)) {
        expect(
          !TRANSPORT_FORBIDDEN_MODULE_PATTERN.test(spec),
          `${relFile} must not import "${spec}" — the transport uses plain ws only`
        ).toBe(true);
      }
    }
  );

  it.each(transportFiles.map((f) => path.relative(serverDir, f)))(
    "transport module %s talks only to server APIs (never the engine)",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      for (const spec of importSpecifiers(source)) {
        expect(
          !spec.startsWith("../game") && !/(?:^|[/@])game(?:\/|$)/.test(spec),
          `${relFile} must not import "${spec}" — the transport goes through ` +
            `createGameServer()/server APIs only; engine access would mean ` +
            `gameplay leaking into the transport`
        ).toBe(true);
      }
    }
  );

  it("the server package is importable without a DOM (this suite runs in node)", () => {
    expect(typeof globalThis.window).toBe("undefined");
  });

  it("has room-management modules to guard (sanity)", () => {
    expect(roomManagementFiles.length).toBeGreaterThanOrEqual(3); // session, roomManager, gameServer (+ barrel)
  });

  it.each(roomManagementFiles.map((f) => path.relative(serverDir, f)))(
    "room module %s drives gameplay only through GameHost (no engine duplication)",
    (relFile) => {
      const source = readFileSync(path.join(serverDir, relFile), "utf8");
      // The room/session layer must not create engines or touch physics:
      // all gameplay flows through createGameHost. (\bcreateGame\b does not
      // match "createGameHost" — the word boundary sees the following H.)
      expect(source, `${relFile} must not call createGame directly`).not.toMatch(
        /\bcreateGame\b/
      );
      expect(source, `${relFile} must not touch matter-js`).not.toMatch(
        /from\s+["']matter-js["']/
      );
    }
  );

  it("RoomManager owns matches through GameHost", () => {
    const source = readFileSync(path.join(serverDir, "roomManager.ts"), "utf8");
    expect(source).toMatch(/\bcreateGameHost\b/);
    expect(source).toMatch(/from\s+["']\.\/gameHost["']/);
  });

  it("the engine remains unaware of rooms, sessions, networking and transport", () => {
    // No engine module imports anything from the server or client layers,
    // or any WebSocket library…
    for (const file of engineFiles) {
      const source = readFileSync(path.join(gameDir, file), "utf8");
      for (const spec of importSpecifiers(source)) {
        expect(
          /(?:server|client|room|session)|\bws\b|websocket/i.test(spec),
          `${file} must not import "${spec}" — the engine cannot depend on ` +
            `the multiplayer layers built on top of it`
        ).toBe(false);
      }
    }
    // …and the engine's public API exposes no room/session/transport surface.
    for (const key of Object.keys(engine)) {
      expect(
        /room|session|server|websocket/i.test(key),
        `the engine barrel must not export "${key}"`
      ).toBe(false);
    }
  });

  it("GameHost remains unaware of WebSockets", () => {
    const source = readFileSync(path.join(serverDir, "gameHost.ts"), "utf8");
    for (const spec of importSpecifiers(source)) {
      expect(
        !/\bws\b|websocket/i.test(spec),
        `gameHost.ts must not import "${spec}" — the host is transport-neutral`
      ).toBe(true);
    }
  });
});
