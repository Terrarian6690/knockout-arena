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
      matchDurationMs: options.matchDurationMs,
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

  // The PWA manifest: on a phone, "Add to home screen" then launches
  // the game with NO browser chrome at all (display: fullscreen) — the
  // other half of the mobile fullscreen story (the in-game gesture is
  // mobileFullscreen.ts on the client). Served from a constant because
  // the server answers / with one file and 404s every other path: an
  // external manifest.json would be a guaranteed 404, exactly like the
  // favicon links that made index.html inline its icons. The single
  // 192px icon rides along as a data URI for the same reason.
  const appManifest = JSON.stringify({
    name: "Knockout Arena",
    short_name: "Knockout",
    description:
      "Six-player physics knockout arena — aim, power, confirm, survive.",
    start_url: "/",
    scope: "/",
    display: "fullscreen",
    orientation: "any",
    background_color: "#0b0e14",
    theme_color: "#0b0e14",
    icons: [
      {
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAACXBIWXMAAE69AABOvQFzamgUAAAf70lEQVR42u1daXRUVbYufX9ev+63XpM5qUqABDKRkIEQZlBoRARBZBJkVGZkBgGRSWmg0RZokUYEmQk4AN0gCiICMgpImEHGKKNgGhrQbhX3O9+lio6xUvecqjtWnW+tvZZDcit17t73nrP3t7/tcJgAInqQWSazDswmMlvBbDez08wuM7tFEsGGW+57e9p9r3HPJ7h9AL7wgCOYwb5gPLP+zN5jdk36g0QpfMPsHWZ9mbmCxel/w6wts7XMfpL3WIITd5ltZ9aL2f/a0fEj3a+3f8h7KaHB1mkms1i7OD7+2O/kfZPQGHeYTWcWYUXHf4BZF7m3lzAAxcwGMfsvqzh/BrPP5X2RMBjIJKWb7fx46t+W90LCJGCrPcgMx/8fZkvk+ktYBAuZ/cYo5y/nTlFJSFhtSxSut/PHMjso11rCojjKLF4v53cxOy/XWMLiOMfMqbXz/14++SVshCPMwrQ88O6UayphM2zX5GDMLrJYrqWETbEgUOd/Vq6hhJH4+eef6f3336dmzZpRVlYWPfTQQzRnzhz617/+5e8luwZS4b0jb4mE3g5/+vRpWrFiBQ0bNowSExOpXLlyv7L8/HwqLi725yNQqE3zp2Fld7As8qVLl2jHjh300Ucf0apVq2jhwoU0a9Ysmjt3Li1btozWrFlDW7ZsoUOHDtF330ken56AE3/88cc0depUatu2bZkO781at27t78eCqvOgSAD0tevT5NixY8ors2fPnvTwww9TfHw89wLDwsLCKDMzk5544gkaPXo0rVu3jv7xD8nq9gc//PADffHFF8qDpnfv3pSXlyd0L7zdm6KiIn//nB68zh/O7LpdFvn777+n9957j7p3707JyckBLXBZFh4ergTThAkT6MiRI9KzywCcE/v3F154gZo0aUIxMTGa34u///3v/v553xIPlZru8fkt/6THlua5556jhIQEXZzel9WrV4/eeOMNunr1asg6+z//+U9l2/jqq69Shw4ddHv4lLb169cH8me/pub8UVY++N69e5c+/PBDatiwoeFO782io6OpT58+yiEumPHTTz/R8ePHqaCggEaNGqW8DfFWNHq9sQX65ptvAvkqOBBH+gqAqVZ1fCw+MgFW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",
      },
    ],
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
    if (url === "/manifest.webmanifest" || url === "/manifest.webmanifest/") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
        res.end(JSON.stringify({ status: "error", detail: "method not allowed" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(appManifest),
      });
      res.end(req.method === "HEAD" ? undefined : appManifest);
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
