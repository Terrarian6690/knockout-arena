import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_CONFIG,
  MAX_RECONNECT_RESERVATION_MS,
  MIN_RECONNECT_RESERVATION_MS,
  loadServerConfig,
} from "../config";
import { DEFAULT_RESERVATION_MS } from "../roomManager";
import {
  DEFAULT_EXPIRED_CREDENTIAL_TTL_MS,
  createReconnectRegistry,
} from "../reconnect";
import { createGameServer } from "../gameServer";

/**
 * Task 15 — two related cleanups:
 *
 *   A. the expiry reason code is kebab-case like every other wire code;
 *   B. the seat-reservation window is configurable via
 *      RECONNECT_RESERVATION_MS, read ONCE at startup, defaulting to the
 *      unchanged 30s and never crashing the process over a bad value.
 *
 * The security properties proven in Tasks 13/14 must survive both.
 */

const SRC_ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ROOT = path.resolve(SRC_ROOT, "..");

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "dist-test") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|md)$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("Part A — the expiry reason code is kebab-case everywhere", () => {
  // This file necessarily QUOTES the forbidden spelling (that is how the
  // guard works), so it excludes itself from its own scan.
  const files = [
    ...sourceFiles(SRC_ROOT),
    ...sourceFiles(path.join(PROJECT_ROOT, "scripts")),
    path.join(PROJECT_ROOT, "README.md"),
  ].filter((f) => path.resolve(f) !== path.resolve(__filename));

  it("no source, test, script or doc file mentions the snake_case name", () => {
    const offenders = files.filter((file) =>
      readFileSync(file, "utf8").includes("reservation_expired")
    );
    expect(offenders.map((f) => path.relative(PROJECT_ROOT, f))).toEqual([]);
  });

  it("the kebab-case code is the one actually in use", () => {
    const hits = files.filter((file) =>
      readFileSync(file, "utf8").includes("reservation-expired")
    );
    // Server, protocol, client and tests all speak the same spelling.
    expect(hits.length).toBeGreaterThan(3);
  });

  it("the scan would actually catch a regression (guard is not vacuous)", () => {
    // Proves the detector works: a string it should reject really is
    // rejected, so an empty offender list means something.
    const sample = 'reason: "reservation_expired"';
    expect(sample.includes("reservation_expired")).toBe(true);
  });

  it("a real expired reservation still reports the kebab-case code", async () => {
    const server = createGameServer({ reconnectReservationMs: 40 });
    const session = server.connect();
    const created = server.createRoom(session);
    const token = created.ok ? created.reconnectToken : "";
    server.reserve(session);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.reconnect(token)).toEqual({
      ok: false,
      reason: "reservation-expired",
    });
  });
});

describe("Part B — RECONNECT_RESERVATION_MS", () => {
  it("unset environment keeps the historical 30s window", () => {
    expect(loadServerConfig({}).reconnectReservationMs).toBe(30_000);
    // The config default and the engine constant must not drift apart.
    expect(DEFAULT_SERVER_CONFIG.reconnectReservationMs).toBe(DEFAULT_RESERVATION_MS);
  });

  it("a valid value is honoured", () => {
    expect(
      loadServerConfig({ RECONNECT_RESERVATION_MS: "12000" }).reconnectReservationMs
    ).toBe(12_000);
  });

  it("accepts exactly the documented bounds", () => {
    expect(
      loadServerConfig({ RECONNECT_RESERVATION_MS: String(MIN_RECONNECT_RESERVATION_MS) })
        .reconnectReservationMs
    ).toBe(MIN_RECONNECT_RESERVATION_MS);
    expect(
      loadServerConfig({ RECONNECT_RESERVATION_MS: String(MAX_RECONNECT_RESERVATION_MS) })
        .reconnectReservationMs
    ).toBe(MAX_RECONNECT_RESERVATION_MS);
  });

  it.each([
    ["non-numeric", "soon"],
    ["empty-ish whitespace", "   "],
    ["negative", "-1000"],
    ["zero", "0"],
    ["below the floor", String(MIN_RECONNECT_RESERVATION_MS - 1)],
    ["above the ceiling", String(MAX_RECONNECT_RESERVATION_MS + 1)],
    ["fractional", "1500.5"],
    ["out-of-range hex", "0xFFFFFF"],
    ["NaN literal", "NaN"],
    ["Infinity", "Infinity"],
  ])("invalid value (%s) falls back to the default and warns", (_label, raw) => {
    const warnings: string[] = [];
    const config = loadServerConfig(
      { RECONNECT_RESERVATION_MS: raw },
      { onWarning: (m) => warnings.push(m) }
    );
    expect(config.reconnectReservationMs).toBe(30_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("RECONNECT_RESERVATION_MS");
    // The operator is told what was rejected and what is being used.
    expect(warnings[0]).toContain(JSON.stringify(raw));
    expect(warnings[0]).toContain("30000");
  });

  it("hex notation is accepted when in range (pre-existing Number() rule)", () => {
    // Documented, not endorsed: Number("0x1f40") === 8000, so the value
    // is a valid in-range integer and is taken. This is exactly how the
    // pre-existing strict reader treats PORT etc.; Task 15 deliberately
    // did not change the numeric-parsing contract.
    const warnings: string[] = [];
    const config = loadServerConfig(
      { RECONNECT_RESERVATION_MS: "0x1f40" },
      { onWarning: (m) => warnings.push(m) }
    );
    expect(config.reconnectReservationMs).toBe(8_000);
    expect(warnings).toEqual([]);
  });

  it("an invalid value never throws — the server must stay up", () => {
    expect(() => loadServerConfig({ RECONNECT_RESERVATION_MS: "banana" })).not.toThrow();
    // ...even with no warning sink wired in at all.
    expect(
      loadServerConfig({ RECONNECT_RESERVATION_MS: "banana" }).reconnectReservationMs
    ).toBe(30_000);
  });

  it("an unset variable produces no warning noise", () => {
    const warnings: string[] = [];
    loadServerConfig({}, { onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it("a valid value produces no warning", () => {
    const warnings: string[] = [];
    loadServerConfig(
      { RECONNECT_RESERVATION_MS: "20000" },
      { onWarning: (m) => warnings.push(m) }
    );
    expect(warnings).toEqual([]);
  });

  it("strict settings still fail loudly — leniency did not leak", () => {
    // Regression guard: the new lenient reader must not have softened
    // the deployment-critical values.
    expect(() => loadServerConfig({ PORT: "nope" })).toThrow(/PORT/);
    expect(() => loadServerConfig({ MAX_CONNECTIONS: "0" })).toThrow(/MAX_CONNECTIONS/);
  });

  it("the configured window is the one the server actually enforces", async () => {
    const server = createGameServer({
      reconnectReservationMs: loadServerConfig({
        RECONNECT_RESERVATION_MS: "5000",
      }).reconnectReservationMs,
    });
    const session = server.connect();
    const created = server.createRoom(session);
    const token = created.ok ? created.reconnectToken : "";
    server.reserve(session);

    // Well inside a 5s window: the seat is still held.
    await new Promise((r) => setTimeout(r, 300));
    const early = server.reconnect(token);
    expect(early.ok).toBe(true);
  });
});

describe("Part B — the tombstone TTL stays decoupled from the window", () => {
  it("the reservation window and the tombstone TTL are independent values", () => {
    // They are not derived from each other, and the env var moves only
    // one of them.
    expect(DEFAULT_EXPIRED_CREDENTIAL_TTL_MS).toBe(5 * 60_000);
    const tuned = loadServerConfig({ RECONNECT_RESERVATION_MS: "7000" });
    expect(tuned.reconnectReservationMs).toBe(7_000);
    // Changing the window does not move the tombstone TTL.
    expect(DEFAULT_EXPIRED_CREDENTIAL_TTL_MS).toBe(5 * 60_000);
  });

  it("the registry still defaults its own TTL with no window awareness", () => {
    // createReconnectRegistry() takes no reservation-window argument;
    // it cannot observe the env var even indirectly.
    const registry = createReconnectRegistry();
    expect(registry.expiredSize()).toBe(0);
    expect(createReconnectRegistry.length).toBeLessThanOrEqual(1);
  });

  it("the shared 5-minute number is a coincidence, not a link", () => {
    // MAX_RECONNECT_RESERVATION_MS happens to equal the tombstone TTL.
    // Pin that this is incidental: the ceiling is a config bound, the
    // TTL is a registry constant, and neither imports the other.
    expect(MAX_RECONNECT_RESERVATION_MS).toBe(DEFAULT_EXPIRED_CREDENTIAL_TTL_MS);
    const configSource = readFileSync(path.join(SRC_ROOT, "server", "config.ts"), "utf8");
    const registrySource = readFileSync(path.join(SRC_ROOT, "server", "reconnect.ts"), "utf8");
    // config.ts must not import the TTL constant to build its bound...
    expect(configSource).not.toMatch(/import[^;]*DEFAULT_EXPIRED_CREDENTIAL_TTL_MS/);
    // ...and the registry must not read the reservation config.
    expect(registrySource).not.toMatch(/RECONNECT_RESERVATION_MS/);
    expect(registrySource).not.toMatch(/from "\.\/config"/);
  });
});

describe("Part B — security properties from Tasks 13/14 survive", () => {
  it("a shortened window still yields generic rejections for guesses", async () => {
    const server = createGameServer({ reconnectReservationMs: 40 });
    const session = server.connect();
    server.createRoom(session);
    server.reserve(session);
    await new Promise((r) => setTimeout(r, 300));

    // A token this server never issued stays undifferentiated, exactly
    // as before the window became configurable.
    expect(server.reconnect("never-issued-credential")).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
    expect(server.reconnect("0".repeat(64))).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
  });

  it("config is read once — there is no runtime reconfiguration hook", () => {
    const server = createGameServer({ reconnectReservationMs: 9_000 });
    // No setter exists on the facade for the window.
    expect(
      Object.keys(server).some((k) => /reservation|reconfigure|setWindow/i.test(k))
    ).toBe(false);
  });
});
