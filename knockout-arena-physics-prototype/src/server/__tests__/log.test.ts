import { describe, expect, it } from "vitest";
import { createServerLogger, type LogLevel } from "../log";

/**
 * The production logger (Task 22): JSON lines with level/time/event,
 * injectable sink, and DEFENSIVE REDACTION — a sensitive field name can
 * never carry its value into a log line, so even a future careless call
 * site cannot leak a reconnect credential or session token.
 */

function capturingSink(): {
  lines: Array<{ level: LogLevel; line: Record<string, unknown> }>;
  sink: (level: LogLevel, text: string) => void;
} {
  const lines: Array<{ level: LogLevel; line: Record<string, unknown> }> = [];
  return {
    lines,
    sink: (level, text) => lines.push({ level, line: JSON.parse(text) }),
  };
}

describe("server logger", () => {
  it("emits one JSON line per event with level, time and event", () => {
    const { lines, sink } = capturingSink();
    const log = createServerLogger({ sink, now: () => new Date("2026-09-06T10:00:00Z") });
    log.info("server_listening", { port: 4173 });
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].line).toMatchObject({
      level: "info",
      event: "server_listening",
      time: "2026-09-06T10:00:00.000Z",
      port: 4173,
    });
  });

  it("routes errors through the same sink with level error", () => {
    const { lines, sink } = capturingSink();
    const log = createServerLogger({ sink });
    log.error("shutdown_failed", { detail: "boom" });
    expect(lines[0].level).toBe("error");
    expect(lines[0].line.event).toBe("shutdown_failed");
  });

  it("REDACTS sensitive field names — credentials can never reach a log line", () => {
    const { lines, sink } = capturingSink();
    const log = createServerLogger({ sink });
    log.warn("connection_refused_limit", {
      connections: 256,
      token: "super-secret-credential",
      reconnectToken: "super-secret-credential",
      sessionToken: "super-secret-session",
      credential: "abc",
      secret: "abc",
      password: "hunter2",
      apiKey: "k-123",
    });
    const raw = JSON.stringify(lines[0].line);
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("k-123");
    expect(lines[0].line.token).toBe("[redacted]");
    expect(lines[0].line.reconnectToken).toBe("[redacted]");
    expect(lines[0].line.connections).toBe(256); // safe fields pass through
  });

  it("never throws — hostile field values cannot break logging", () => {
    const { sink } = capturingSink();
    const log = createServerLogger({ sink });
    const hostile = {
      get detail(): string {
        throw new Error("boom");
      },
    };
    expect(() => log.info("event", hostile)).not.toThrow();
    expect(() => log.info("event", undefined)).not.toThrow();
    expect(() => log.info("event", { a: BigInt(1) as unknown as number })).not.toThrow();
  });

  it("works without a sink (default stdout/stderr) without throwing", () => {
    const log = createServerLogger();
    expect(() => log.info("event", { ok: true })).not.toThrow();
  });
});
