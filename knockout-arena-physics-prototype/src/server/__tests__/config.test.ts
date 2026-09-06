import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_SERVER_CONFIG, loadServerConfig } from "../config";

/**
 * The production configuration layer (Task 22): every environment
 * variable has a local-development default, and every value is validated
 * LOUDLY — an invalid setting must fail at startup with a field-specific
 * error, never silently behave incorrectly.
 */

describe("server configuration", () => {
  it("empty environment yields the documented defaults", () => {
    expect(loadServerConfig({})).toEqual({
      port: 4173,
      host: "0.0.0.0",
      nodeEnv: "development",
      maxPayloadBytes: 64 * 1024,
      maxConnections: 256,
      maxMalformedMessages: 32,
      shutdownTimeoutMs: 10_000,
    });
    expect(DEFAULT_SERVER_CONFIG.port).toBe(4173);
  });

  it("valid overrides are parsed", () => {
    const config = loadServerConfig({
      PORT: "8443",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      MAX_PAYLOAD_BYTES: "2048",
      MAX_CONNECTIONS: "10",
      MAX_MALFORMED_MESSAGES: "3",
      SHUTDOWN_TIMEOUT_MS: "2500",
    });
    expect(config).toEqual({
      port: 8443,
      host: "127.0.0.1",
      nodeEnv: "production",
      maxPayloadBytes: 2048,
      maxConnections: 10,
      maxMalformedMessages: 3,
      shutdownTimeoutMs: 2500,
    });
  });

  it("empty-string values fall back to defaults (unset-style)", () => {
    expect(loadServerConfig({ PORT: "", HOST: "" }).port).toBe(4173);
    expect(loadServerConfig({ PORT: "", HOST: "" }).host).toBe("0.0.0.0");
  });

  it("unknown environment variables are ignored (no silent coupling)", () => {
    expect(loadServerConfig({ SOMETHING_ELSE: "42" }).port).toBe(4173);
  });

  it.each([
    ["PORT", "abc"],
    ["PORT", "0"],
    ["PORT", "-1"],
    ["PORT", "65536"],
    ["PORT", "1.5"],
    ["MAX_PAYLOAD_BYTES", "0"],
    ["MAX_PAYLOAD_BYTES", "-5"],
    ["MAX_CONNECTIONS", "abc"],
    ["MAX_CONNECTIONS", "0"],
    ["MAX_MALFORMED_MESSAGES", "-1"],
    ["SHUTDOWN_TIMEOUT_MS", "0"],
    ["SHUTDOWN_TIMEOUT_MS", "50"], // below the 100 ms floor
  ])("invalid %s=%j fails loudly with the field named", (field, value) => {
    try {
      loadServerConfig({ [field]: value });
      expect.fail(`expected ${field}=${value} to be rejected`);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("configuration error");
      expect(message).toContain(field);
      expect(message).toContain(String(value));
    }
  });

  it.each([
    "  ",
    "http://example.com",
    "wss://example.com",
    "example.com/path",
  ])("HOST=%j (a URL, not an address) is rejected", (host) => {
    expect(() => loadServerConfig({ HOST: host })).toThrow(ConfigError);
    expect(() => loadServerConfig({ HOST: host })).toThrow(/HOST/);
  });

  it("HOST trims a plain address", () => {
    expect(loadServerConfig({ HOST: " 127.0.0.1 " }).host).toBe("127.0.0.1");
    expect(loadServerConfig({ HOST: "localhost" }).host).toBe("localhost");
  });

  it("NODE_ENV is informational only — any value is accepted", () => {
    expect(loadServerConfig({ NODE_ENV: "staging" }).nodeEnv).toBe("staging");
    expect(loadServerConfig({ NODE_ENV: "42" }).nodeEnv).toBe("42");
  });
});
