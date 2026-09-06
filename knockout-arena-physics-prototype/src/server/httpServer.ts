import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { createGameServer, type GameServer } from "./gameServer";
import { createServerLogger, type ServerLogger } from "./log";
import {
  createTransportCore,
  type ConnectionHandle,
  type TransportCore,
  type TransportOptions,
  type TransportSocket,
} from "./webSocketTransport";

/**
 * The production server edge: ONE node:http server that serves
 *
 *   - GET/HEAD /health   → 200 {"status":"ok"} — a tiny, stateless,
 *     database-free, room-free response fit for load-balancer probes;
 *   - GET /              → the built single-file client (dist/index.html);
 *   - WebSocket upgrade  → protocol v1 (createTransportCore around
 *     createGameServer), with a frame-size cap enforced by the ws layer.
 *
 * Shutdown is GRACEFUL, IDEMPOTENT and BOUNDED (close()):
 *   1. stop accepting new connections and upgrades;
 *   2. close every WebSocket cleanly (transport force-close — seats are
 *      released, no reservations);
 *   3. stop the HTTP server (lingering keep-alive sockets are ended
 *      after a short grace);
 *   4. destroy the game server (stops every GameHost tick loop, clears
 *      rooms, sessions and reconnect credentials);
 *   5. resolve — or resolve anyway once the shutdown timeout expires,
 *      so a stuck socket can never hang the process.
 *
 * All lifecycle and limit events go through the redacting logger
 * (log.ts): no credentials, no session tokens, no client payloads.
 */

export interface HttpGameServerOptions extends TransportOptions {
  /** Port to listen on; 0 (default) picks a free ephemeral port (tests). */
  port?: number;
  /** Address to bind. Default "0.0.0.0" (containers/reverse proxies). */
  host?: string;
  /**
   * Absolute path of the built single-file client (dist/index.html).
   * Required for serving the app; /health works without it.
   */
  staticFile?: string;
  /** Inject an existing game server (tests); by default one is created. */
  gameServer?: GameServer;
  /**
   * Bound on the whole graceful shutdown. Default 10 000 ms. Close()
   * always resolves within this bound.
   */
  shutdownTimeoutMs?: number;
  /** Redacting lifecycle logger (see log.ts); default: stdout/stderr JSON. */
  logger?: ServerLogger;
}

export interface HttpGameServer {
  /** The port actually listening (resolves the ephemeral-port case). */
  port(): number;
  /** The game server this edge owns (or was given). */
  gameServer: GameServer;
  /** True once close() has started (idempotency is internal). */
  closed(): boolean;
  /**
   * Graceful shutdown. Idempotent: every call after the first resolves
   * with the SAME promise. Bounded: resolves by shutdownTimeoutMs even
   * if a socket refuses to die.
   */
  close(): Promise<void>;
  /** Test/observability handle for the underlying transport core. */
  transport: TransportCore;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** Grace before forcibly ending lingering keep-alive HTTP sockets. */
const KEEPALIVE_GRACE_MS = 250;

export async function createHttpGameServer(
  options: HttpGameServerOptions = {}
): Promise<HttpGameServer> {
  const logger = options.logger ?? createServerLogger();
  const ownsGameServer = options.gameServer === undefined;
  const gameServer =
    options.gameServer ?? createGameServer({
      reconnectReservationMs: options.reconnectReservationMs,
      roundDecisionTimeoutMs: options.roundDecisionTimeoutMs,
    });

  const staticFile = options.staticFile;
  const appHtml = staticFile !== undefined ? readFileSync(staticFile) : null;

  const core: TransportCore = createTransportCore(gameServer, {
    snapshotBufferLimitBytes: options.snapshotBufferLimitBytes,
    maxConnections: options.maxConnections,
    maxMalformedMessages: options.maxMalformedMessages,
    logger,
  });

  let shuttingDown = false;

  const httpServer: Server = createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      // The static handler must never take the process down.
      logger?.error("http_request_error", { detail: String(err).slice(0, 200) });
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    }
  });

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    // Health first: tiny, stateless, no room/game dependency.
    if (url === "/health" || url === "/health/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
        res.end(JSON.stringify({ status: "error", detail: "method not allowed" }));
        return;
      }
      const body = JSON.stringify({ status: "ok" });
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (shuttingDown) {
      // New HTTP traffic during shutdown: refused fast, no state touched.
      res.writeHead(503, { "content-type": "text/plain", "retry-after": "1" });
      res.end("server is shutting down");
      return;
    }
    if (req.method !== "GET" || url !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (appHtml === null) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("no client bundle configured (STATIC_FILE missing) — /health is available");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(appHtml);
  }

  // ── the WebSocket edge (protocol v1 on the same port) ────────────────
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 64 * 1024,
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (shuttingDown) {
      socket.destroy(); // stop accepting new connections mid-shutdown
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    core.attach(adaptWsSocket(ws));
  });
  wss.on("error", (err) => {
    // A ws-server-level failure must be visible, never silent.
    logger?.error("websocket_server_error", { detail: String(err).slice(0, 200) });
  });

  // ── graceful, idempotent, bounded shutdown ───────────────────────────
  let closePromise: Promise<void> | null = null;

  function shutdown(): Promise<void> {
    if (closePromise !== null) return closePromise; // idempotent
    const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    closePromise = new Promise<void>((resolve) => {
      shuttingDown = true; // no new HTTP traffic, no new upgrades
      const finish = () => {
        if (ownsGameServer) gameServer.destroy(); // stops every host loop
        logger?.info("server_stopped");
        resolve();
      };
      const bail = setTimeout(() => {
        // Bounded: never hang on a socket that refuses to die.
        logger?.warn("shutdown_timeout", { timeoutMs });
        httpServer.closeAllConnections?.();
        finish();
      }, timeoutMs);
      const done = () => {
        clearTimeout(bail);
        finish();
      };
      // 1) close every WebSocket cleanly (force mode: release everything)
      core.close();
      // 2) stop accepting new HTTP connections; after a short grace,
      //    end lingering keep-alive sockets so close() resolves promptly.
      httpServer.close(() => done());
      setTimeout(() => httpServer.closeAllConnections?.(), KEEPALIVE_GRACE_MS).unref?.();
    });
    return closePromise;
  }

  // ── listen ────────────────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => {
      httpServer.off("error", onError);
      httpServer.on("error", (err) => {
        logger?.error("http_server_error", { detail: String(err).slice(0, 200) });
      });
      resolve();
    });
  });
  const address = httpServer.address();
  const listeningPort =
    typeof address === "object" && address !== null ? address.port : (options.port ?? 0);
  logger?.info("server_listening", {
    port: listeningPort,
    host: options.host ?? "0.0.0.0",
    protocol: 1,
  });

  return {
    port: () => listeningPort,
    gameServer,
    closed: () => shuttingDown,
    close: shutdown,
    transport: core,
  };
}

/**
 * Adapt a `ws` WebSocket to the transport's minimal socket interface —
 * identical to the adapter in webSocketTransport.ts, duplicated only
 * because the transport keeps it private and both must stay in the
 * networking family (see server-boundary.test.ts).
 */
function adaptWsSocket(ws: WebSocket): TransportSocket {
  return {
    send: (data) => {
      ws.send(data);
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onMessage: (cb) => {
      ws.on("message", (raw: RawData) => cb(rawDataToString(raw)));
    },
    onClose: (cb) => {
      ws.on("close", () => cb());
    },
    onError: (cb) => {
      ws.on("error", (err) => cb(err));
    },
    close: () => {
      ws.close();
    },
  };
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  return new TextDecoder().decode(raw);
}

/** Re-exported for the entrypoint/tests: the handle type is public API. */
export type { ConnectionHandle };
