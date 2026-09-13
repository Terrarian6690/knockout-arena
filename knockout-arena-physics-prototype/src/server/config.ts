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
 *   RECONNECT_RESERVATION_MS 30000    How long a dropped player's seat is
 *                                     held for reconnect (5000..300000)
 *
 * NOTE ON VALIDATION STYLE: every variable above fails LOUDLY except
 * RECONNECT_RESERVATION_MS, which warns and falls back to its default.
 * That is deliberate: the others describe how the process must run (a
 * bad port or connection cap means the operator got the deployment
 * wrong), whereas the reservation window is a gameplay tuning knob — a
 * typo in it should not take a running game server offline. The
 * fallback is always the documented 30s default, never the bad value.
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
  /**
   * How long a dropped connection's seat stays reserved for reconnect.
   * Read once at startup; never hot-reloaded.
   */
  readonly reconnectReservationMs: number;
}

export const DEFAULT_SERVER_CONFIG: Readonly<Omit<ServerConfig, "nodeEnv">> = {
  port: 4173,
  host: "0.0.0.0",
  maxPayloadBytes: 64 * 1024,
  maxConnections: 256,
  maxMalformedMessages: 32,
  shutdownTimeoutMs: 10_000,
  reconnectReservationMs: 30_000,
};

/**
 * Sanity bounds for RECONNECT_RESERVATION_MS.
 *
 * Lower bound 5s: below this the window is degenerate — a real client
 * cannot notice the drop, re-establish a socket and replay its
 * credential in time, so every drop would become a permanent
 * elimination while still paying the full reconnect machinery cost.
 *
 * Upper bound 5 minutes: a seat held this long already blocks the room
 * and pins per-seat state for an opponent who has almost certainly
 * left; anything beyond is indistinguishable from a leak.
 *
 * The upper bound happening to equal DEFAULT_EXPIRED_CREDENTIAL_TTL_MS
 * is a COINCIDENCE, not a dependency: the tombstone TTL is hardcoded in
 * reconnect.ts and starts counting only once a reservation has already
 * expired. The two values are never derived from each other.
 */
export const MIN_RECONNECT_RESERVATION_MS = 5_000;
export const MAX_RECONNECT_RESERVATION_MS = 300_000;

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

/**
 * Read an integer that must NOT be able to crash the server: an absent,
 * malformed or out-of-range value falls back to `fallback` and reports
 * one human-readable warning line. Returns the default on every failure.
 */
function readIntegerLenient(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  onWarning: ((message: string) => void) | undefined
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    onWarning?.(
      `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)}) — using the default ${fallback}`
    );
    return fallback;
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
export interface LoadConfigOptions {
  /**
   * Called with one human-readable line per value that was present but
   * unusable. Only the lenient settings can reach this; strict ones
   * still throw. Injectable so tests can assert the warning path.
   */
  onWarning?: (message: string) => void;
}

export function loadServerConfig(
  env: Record<string, string | undefined>,
  options: LoadConfigOptions = {}
): ServerConfig {
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
    // Lenient on purpose — see NOTE ON VALIDATION STYLE above.
    reconnectReservationMs: readIntegerLenient(
      env,
      "RECONNECT_RESERVATION_MS",
      DEFAULT_SERVER_CONFIG.reconnectReservationMs,
      MIN_RECONNECT_RESERVATION_MS,
      MAX_RECONNECT_RESERVATION_MS,
      options.onWarning
    ),
  };
}
