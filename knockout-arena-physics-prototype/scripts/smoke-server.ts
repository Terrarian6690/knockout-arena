import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { createGameServer, createTransportCore, type TransportSocket } from "../src/server";

/**
 * MANUAL SMOKE-TEST SERVER (dev helper — not the production entry point).
 *
 * Serves the built single-file app (dist/index.html) and speaks protocol v1
 * on the SAME port, so the browser client's default same-origin server URL
 * works out of the box:
 *
 *   npm run build
 *   npm run smoke            # → http://localhost:4173
 *
 * Then open the URL in two browser windows and run the manual multiplayer
 * smoke test described in the README ("Manual multiplayer smoke test").
 *
 * Everything gameplay-bearing goes through the real production stack:
 * createGameServer() + createTransportCore() + the engine's GameHost. The
 * only glue here is the HTTP file server and the ws socket adapter, which
 * mirrors src/server/webSocketTransport.ts's adapter 1:1.
 */

const PORT = Number(process.env.PORT ?? 4173);
const APP_FILE = path.resolve(process.cwd(), "dist", "index.html");

const httpServer = createServer((_req, res) => {
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(APP_FILE));
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("dist/index.html not found — run `npm run build` first.");
  }
});

const gameServer = createGameServer();
const core = createTransportCore(gameServer);

const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => core.attach(adaptWsSocket(ws)));

process.on("SIGTERM", () => {
  core.close();
  gameServer.destroy();
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  core.close();
  gameServer.destroy();
  httpServer.close(() => process.exit(0));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Smoke server ready:`);
  console.log(`  app + protocol v1 on  http://localhost:${PORT} (ws://localhost:${PORT})`);
});

/** Mirrors the production adapter in src/server/webSocketTransport.ts. */
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
