import { existsSync } from "node:fs";
import path from "node:path";
import { loadServerConfig } from "../src/server/config";
import { createServerLogger } from "../src/server/log";
import { createHttpGameServer } from "../src/server/httpServer";

/**
 * PRODUCTION SERVER ENTRYPOINT.
 *
 *   npm ci
 *   npm run build        # the client bundle (dist/index.html)
 *   npm start            # serves the app + protocol v1 + /health
 *
 * Configuration comes from the environment (see src/server/config.ts):
 * PORT, HOST, NODE_ENV, MAX_PAYLOAD_BYTES, MAX_CONNECTIONS,
 * MAX_MALFORMED_MESSAGES, SHUTDOWN_TIMEOUT_MS. Invalid values fail
 * loudly at startup; nothing here is a secret.
 *
 * Lifecycle: SIGTERM/SIGINT trigger ONE idempotent graceful shutdown
 * (close sockets → stop hosts → stop listening → exit 0). A second
 * signal exits immediately — cleanup never runs twice. Anything still
 * unresolved by SHUTDOWN_TIMEOUT_MS is forcibly ended (exit 1).
 */

const logger = createServerLogger();

let config;
try {
  config = loadServerConfig(process.env);
} catch (err) {
  logger.error("startup_config_invalid", { detail: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const staticFile = path.resolve(process.cwd(), "dist", "index.html");
if (!existsSync(staticFile)) {
  logger.error("startup_client_bundle_missing", {
    detail: "dist/index.html not found — run `npm run build` before `npm start`",
  });
  process.exit(1);
}

const server = await createHttpGameServer({
  port: config.port,
  host: config.host,
  staticFile,
  maxPayloadBytes: config.maxPayloadBytes,
  maxConnections: config.maxConnections,
  maxMalformedMessages: config.maxMalformedMessages,
  shutdownTimeoutMs: config.shutdownTimeoutMs,
  logger,
});

logger.info("server_ready", {
  port: server.port(),
  host: config.host,
  nodeEnv: config.nodeEnv,
  app: "/",
  health: "/health",
  websocket: "same origin (protocol v1)",
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    // A second signal means "exit NOW" — cleanup never runs twice.
    logger.warn("shutdown_forced", { signal });
    process.exit(1);
  }
  shuttingDown = true;
  logger.info("shutdown_begin", { signal });
  const timer = setTimeout(() => {
    logger.error("shutdown_incomplete", { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  server
    .close()
    .then(() => {
      clearTimeout(timer);
      logger.info("shutdown_complete");
      process.exit(0);
    })
    .catch((err) => {
      clearTimeout(timer);
      logger.error("shutdown_failed", { detail: String(err).slice(0, 200) });
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Defense-in-depth: surface unexpected process-level failures loudly
// (the wire path itself is total and never throws — see the transport).
process.on("uncaughtException", (err) => {
  logger.error("uncaught_exception", { detail: String(err).slice(0, 300) });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { detail: String(reason).slice(0, 300) });
  process.exit(1);
});
