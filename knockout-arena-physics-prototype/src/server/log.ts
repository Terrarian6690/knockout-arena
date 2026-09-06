/**
 * Minimal production logging for the game server.
 *
 * One JSON line per event on stdout (errors on stderr): level, time,
 * event and a few safe fields — enough to diagnose lifecycle problems,
 * never enough to leak secrets. There is deliberately NO logging
 * framework here; if the deployment grows up, swap the sink.
 *
 * Safety rules (test-pinned):
 *   - known-sensitive field names (tokens, credentials, secrets) are
 *     redacted defensively, so even a future careless call site cannot
 *     print a reconnect credential or session token;
 *   - nothing logs per-frame/per-tick — lifecycle and limits only;
 *   - full client payloads are never logged (call sites pass counts and
 *     codes, not raw wire data).
 */

export type LogLevel = "info" | "warn" | "error";

/** Field names that must never appear in a log line with their value. */
const SENSITIVE_FIELD_NAMES = new Set([
  "token",
  "reconnectToken",
  "sessionToken",
  "credential",
  "secret",
  "password",
  "apiKey",
  "authorization",
]);

export type LogFields = Record<string, unknown>;

export interface ServerLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Injectable sink (tests). Defaults: info/warn → stdout, error → stderr. */
  sink?: (level: LogLevel, line: string) => void;
  /** Injectable clock (tests). Default: () => new Date(). */
  now?: () => Date;
}

/** Defensive redaction: sensitive keys never carry their value into a log. */
function redact(fields: LogFields | undefined): LogFields {
  if (fields === undefined) return {};
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SENSITIVE_FIELD_NAMES.has(key) ? "[redacted]" : value;
  }
  return out;
}

export function createServerLogger(options?: LoggerOptions): ServerLogger {
  const sink =
    options?.sink ??
    ((level, line) => {
      if (level === "error") console.error(line);
      else console.log(line);
    });
  const now = options?.now ?? (() => new Date());
  function emit(level: LogLevel, event: string, fields?: LogFields): void {
    try {
      sink(level, JSON.stringify({ time: now().toISOString(), level, event, ...redact(fields) }));
    } catch {
      // Logging must never take the server down — not even for hostile
      // field values (circular structures, throwing getters).
    }
  }
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
