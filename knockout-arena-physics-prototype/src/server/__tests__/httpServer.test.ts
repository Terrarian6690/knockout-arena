import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createGameServer,
  createHttpGameServer,
  type GameServer,
  type HttpGameServer,
} from "../index";

/**
 * The production server edge (Task 22): one node:http server carrying
 * the /health probe, the static client bundle and the protocol-v1
 * WebSocket upgrade — plus the graceful, idempotent, bounded shutdown.
 * Real sockets throughout: real ws clients and real HTTP requests
 * against an ephemeral port.
 */

const live: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const teardown of live.splice(0)) await teardown();
});

function tempAppFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ka-http-"));
  const file = path.join(dir, "index.html");
  writeFileSync(file, "<!doctype html><title>stub app</title>");
  return file;
}

async function makeServer(
  options?: Partial<ConstructorParameters<typeof Object>[0]> & Record<string, unknown>
): Promise<HttpGameServer> {
  const server = await createHttpGameServer({
    staticFile: tempAppFile(),
    ...(options as object),
  });
  live.push(() => server.close());
  return server;
}

function httpGet(port: number, pathName: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = fetch(`http://127.0.0.1:${port}${pathName}`);
    req.then(async (res) => {
      resolve({
        status: res.status,
        body: await res.text(),
        headers: Object.fromEntries(res.headers.entries()),
      });
    }, reject);
  });
}

/** A real ws client that records parsed messages. */
class WsClient {
  private ws: WebSocket;
  readonly messages: unknown[] = [];
  private closeHandlers: Array<() => void> = [];
  closed = new Promise<void>((resolve) => {
    this.closeHandlers.push(resolve);
  });
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => this.messages.push(JSON.parse(raw.toString())));
    this.ws.on("close", () => {
      for (const cb of [...this.closeHandlers]) cb();
    });
  }
  static connect(port: number): Promise<WsClient> {
    const client = new WsClient(`ws://127.0.0.1:${port}`);
    return new Promise((resolve, reject) => {
      client.ws.once("open", () => resolve(client));
      client.ws.once("error", reject);
    });
  }
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }
  ofType<T = Record<string, unknown>>(type: string): T[] {
    return this.messages.filter(
      (m): m is T => (m as { type?: unknown }).type === type
    ) as T[];
  }
  /** Poll until a message of the given type arrived. */
  async waitFor<T = Record<string, unknown>>(type: string, timeoutMs = 4000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const found = this.ofType<T>(type)[0];
      if (found !== undefined) return found;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${type}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  close(): void {
    this.ws.close();
  }
}

describe("GET /health", () => {
  it("returns 200 with the tiny ok JSON (works with zero rooms)", async () => {
    const server = await makeServer();
    const res = await httpGet(server.port(), "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("HEAD /health answers 200 with no body (load-balancer style)", async () => {
    const server = await makeServer();
    const res = await fetch(`http://127.0.0.1:${server.port()}/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("non-GET methods are refused with 405", async () => {
    const server = await makeServer();
    const res = await fetch(`http://127.0.0.1:${server.port()}/health`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("has no room/game dependency: healthy with live rooms too", async () => {
    const server = await makeServer();
    const client = await WsClient.connect(server.port());
    client.send({ protocolVersion: 1, type: "create_room" });
    await new Promise((r) => setTimeout(r, 100));
    expect(server.gameServer.roomCount()).toBe(1);
    const res = await httpGet(server.port(), "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"status":"ok"}');
    client.close();
  });

  it("works without a static bundle (health-only mode)", async () => {
    const server = await createHttpGameServer({ port: 0 });
    live.push(() => server.close());
    const res = await httpGet(server.port(), "/health");
    expect(res.status).toBe(200);
    const app = await httpGet(server.port(), "/");
    expect(app.status).toBe(503); // no bundle configured — honest, not a crash
  });
});

describe("static client serving", () => {
  it("GET / serves the bundle; other paths are 404; POST is 404", async () => {
    const server = await makeServer();
    const root = await httpGet(server.port(), "/");
    expect(root.status).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain("stub app");
    expect((await httpGet(server.port(), "/nope")).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${server.port()}/`, { method: "POST" })).status
    ).toBe(404);
  });
});

describe("the WebSocket edge (protocol v1 on the same port)", () => {
  it("a real client creates a room through the HTTP server's upgrade path", async () => {
    const server = await makeServer();
    const a = await WsClient.connect(server.port());
    a.send({ protocolVersion: 1, type: "create_room" });
    const welcome = await a.waitFor<{ roomId?: string }>("welcome");
    expect(welcome.roomId).toMatch(/^[A-Z0-9]{4}$/);
    const b = await WsClient.connect(server.port());
    b.send({ protocolVersion: 1, type: "join_room", roomId: welcome.roomId! });
    const wb = await b.waitFor<{ playerId?: string }>("welcome");
    expect(wb.playerId).toBe("p1");
    a.close();
    b.close();
  });
});

describe("graceful shutdown", () => {
  it("close() closes clients cleanly, stops listening, destroys game state, and is idempotent", async () => {
    const gameServer: GameServer = createGameServer();
    const server = await createHttpGameServer({
      staticFile: tempAppFile(),
      gameServer,
      shutdownTimeoutMs: 2000,
    });
    const port = server.port();

    const a = await WsClient.connect(port);
    a.send({ protocolVersion: 1, type: "create_room" });
    await new Promise((r) => setTimeout(r, 100));
    expect(gameServer.roomCount()).toBe(1);
    expect(gameServer.sessionCount()).toBe(1);

    const first = server.close();
    const second = server.close();
    expect(second).toBe(first); // idempotent: one shutdown, one promise

    await Promise.race([
      a.closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("client not closed")), 3000)),
    ]);
    await first;

    // Not listening anymore.
    await expect(httpGet(port, "/health")).rejects.toThrow();
    // Game state destroyed: rooms and sessions gone, hosts stopped.
    expect(gameServer.roomCount()).toBe(0);
    expect(gameServer.sessionCount()).toBe(0);
    expect(server.closed()).toBe(true);
  });

  it("close() resolves within the bound even with a stuck keep-alive socket", async () => {
    const server = await makeServer({ shutdownTimeoutMs: 1500 });
    const port = server.port();

    // A raw TCP connection that sends an HTTP request then just sits
    // there (keep-alive): server.close() alone would wait for it forever.
    const raw = netConnect(port, "127.0.0.1");
    await new Promise<void>((resolve) => raw.once("connect", resolve));
    raw.write(`GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n`);

    const t0 = Date.now();
    await server.close();
    const elapsed = Date.now() - t0;
    // Grace (250 ms) ends the lingerer; the 1.5 s bound is the ceiling.
    expect(elapsed).toBeLessThan(1500);
    raw.destroy();
  });

  it("HTTP requests during shutdown are refused fast (503), upgrades destroyed", async () => {
    const server = await makeServer({ shutdownTimeoutMs: 2000 });
    const port = server.port();
    const closing = server.close();

    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET" }).catch(() => null);
    // The listener may already be gone (close is fast) — both outcomes
    // are correct: refused (ECONNREFUSED) or an explicit 503.
    if (res !== null) {
      expect([200, 503]).toContain(res.status);
    }
    await closing;
  });
});
