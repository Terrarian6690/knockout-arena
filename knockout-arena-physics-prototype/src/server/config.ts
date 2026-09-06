/**
 * Production server configuration — explicit, minimal, validated.
 *
 * Every value comes from the environment with a local-development
 * default, and every value is validated LOUDLY: an invalid setting
 * throws a field-specific error at startup instead of silently behaving
 * incorrectly (NaN ports, zero limits, negative timeouts).
 *
 * Supported environment variables (and defaults):
 *
 *   PORT                     4173     TCP port to listen on (1..65535)
 *   HOST                     0.0.0.0  Address to bind (IP or hostname)
 *   NODE_ENV                 development  Informational only
 *   MAX_PAYLOAD_BYTES        65536    Max inbound WebSocket frame (bytes)
 *   MAX_CONNECTIONS          256      Max simultaneous connections
 *   MAX_MALFORMED_MESSAGES   32       Malformed wire messages per
 *                                     connection before it is closed
 *   SHUTDOWN_TIMEOUT_MS      10000    Bound on graceful shutdown
 *
 * There are no secrets in this configuration (nothing to commit), no
 * hardcoded production URLs, and no client exposure: the client needs no
 * server-side values — it connects same-origin.
 */

/** A configuration value failed validation. The message names the field. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`configuration error: ${message}`);
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  /** Informational (the server behaves the same in every env). */
  readonly nodeEnv: string;
  readonly maxPayloadBytes: number;
  readonly maxConnections: number;
  readonly maxMalformedMessages: number;
  readonly shutdownTimeoutMs: number;
}

export const DEFAULT_SERVER_CONFIG: Readonly<Omit<ServerConfig, "nodeEnv">> = {
  port: 4173,
  host: "0.0.0.0",
  maxPayloadBytes: 64 * 1024,
  maxConnections: 256,
  maxMalformedMessages: 32,
  shutdownTimeoutMs: 10_000,
};

function readInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`
    );
  }
  return value;
}

function readHost(env: Record<string, string | undefined>): string {
  const raw = env.HOST;
  if (raw === undefined || raw === "") return DEFAULT_SERVER_CONFIG.host;
  const host = raw.trim();
  if (host.length === 0 || /\s/.test(host) || host.includes("://") || host.includes("/")) {
    throw new ConfigError(
      `HOST must be an IP address or hostname, not a URL (got ${JSON.stringify(raw)})`
    );
  }
  return host;
}

/**
 * Parse and validate the environment. Throws {@link ConfigError} on the
 * first invalid value — the entrypoint logs it and exits non-zero.
 */
export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    port: readInteger(env, "PORT", DEFAULT_SERVER_CONFIG.port, 1, 65535),
    host: readHost(env),
    nodeEnv: env.NODE_ENV === undefined || env.NODE_ENV === "" ? "development" : env.NODE_ENV,
    maxPayloadBytes: readInteger(
      env,
      "MAX_PAYLOAD_BYTES",
      DEFAULT_SERVER_CONFIG.maxPayloadBytes,
      1,
      16 * 1024 * 1024
    ),
    maxConnections: readInteger(
      env,
      "MAX_CONNECTIONS",
      DEFAULT_SERVER_CONFIG.maxConnections,
      1,
      100_000
    ),
    maxMalformedMessages: readInteger(
      env,
      "MAX_MALFORMED_MESSAGES",
      DEFAULT_SERVER_CONFIG.maxMalformedMessages,
      1,
      100_000
    ),
    shutdownTimeoutMs: readInteger(
      env,
      "SHUTDOWN_TIMEOUT_MS",
      DEFAULT_SERVER_CONFIG.shutdownTimeoutMs,
      100,
      120_000
    ),
  };
}
