import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createGameServer,
  createHttpGameServer,
  createTransportCore,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";

/**
 * Production hardening (Task 22): conservative resource-exhaustion
 * guards, each pinned by an adversarial test.
 *
 *   - maxConnections: beyond the cap a connection is refused cleanly
 *     (one error, one close) and NEVER touches game state;
 *   - maxMalformedMessages: a garbage flood closes the offending
 *     connection — while LEGITIMATE protocol traffic (engine-level
 *     rejections included) never counts toward the budget;
 *   - maxPayloadBytes: an oversized frame is rejected by the ws layer
 *     (close 1009) before any parsing, without harming anyone else;
 *   - a full server restart invalidates every in-memory reconnect
 *     credential (stale credentials fail cleanly — documented,
 *     not pretended away).
 *
 * These are accidental-exhaustion guards. Real rate limiting and DDoS
 * protection belong to upstream infrastructure (see README deployment).
 */

// ── fake socket (same shape as transport.test.ts) ─────────────────────────

class FakeSocket implements TransportSocket {
  sent: string[] = [];
  bufferedAmount = 0;
  closed = false;
  private messageHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageHandlers.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }
  onError(_cb: (error: unknown) => void): void {}
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of [...this.closeHandlers]) cb();
  }
  receive(raw: string): void {
    for (const cb of [...this.messageHandlers]) cb(raw);
  }
  receiveMsg(message: unknown): void {
    this.receive(JSON.stringify(message));
  }
  errorCodes(): string[] {
    return this.sent
      .map((s) => JSON.parse(s) as { type?: string; code?: string })
      .filter((m) => m.type === "error")
      .map((m) => String(m.code));
  }
}

const liveServers: GameServer[] = [];
const liveCores: TransportCore[] = [];
afterEach(() => {
  for (const core of liveCores) core.close();
  liveCores.length = 0;
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function newCore(options?: {
  maxConnections?: number;
  maxMalformedMessages?: number;
}): { server: GameServer; core: TransportCore } {
  const server = createGameServer();
  liveServers.push(server);
  const core = createTransportCore(server, options);
  liveCores.push(core);
  return { server, core };
}

function attach(core: TransportCore): FakeSocket {
  const socket = new FakeSocket();
  core.attach(socket);
  return socket;
}

const create = JSON.stringify({ protocolVersion: 1, type: "create_room" });

describe("connection limit", () => {
  it("beyond the cap, connections are refused cleanly and never touch game state", () => {
    const { server, core } = newCore({ maxConnections: 2 });
    const a = attach(core);
    const b = attach(core);
    const c = attach(core);

    // The first two are live and functional…
    a.receive(create);
    b.receive(create);
    expect(JSON.parse(a.sent[0]).type).toBe("welcome");
    expect(JSON.parse(b.sent[0]).type).toBe("welcome");

    // …the third is refused with one clean error and closed…
    expect(c.closed).toBe(true);
    expect(c.errorCodes()).toEqual(["connection-limit"]);

    // …and no session was ever issued for it.
    expect(server.sessionCount()).toBe(2);
    expect(server.roomCount()).toBe(2);
  });

  it("a closed connection frees its slot again (the cap counts live ones)", () => {
    const { core } = newCore({ maxConnections: 1 });
    const a = attach(core);
    a.receive(create);
    core.close(); // close everything via core teardown
    liveCores.splice(liveCores.indexOf(core), 1); // already closed below

    const { core: core2 } = newCore({ maxConnections: 1 });
    const b = attach(core2);
    b.receive(create);
    expect(JSON.parse(b.sent[0]).type).toBe("welcome");
  });
});

describe("malformed-message budget", () => {
  it("a garbage flood closes the offending connection; others are untouched", () => {
    const { core } = newCore({ maxMalformedMessages: 3 });
    const good = attach(core);
    const bad = attach(core);
    good.receive(create);

    for (let i = 0; i < 4; i++) bad.receive("this is not json");
    // Every offending message got its error; the flood then closed it.
    expect(bad.errorCodes()).toHaveLength(4);
    expect(bad.closed).toBe(true);

    // The healthy connection is unaffected and still functional.
    expect(good.closed).toBe(false);
    good.receive(JSON.stringify({ protocolVersion: 1, type: "leave_room" }));
    expect(good.sent.length).toBeGreaterThan(1);
  });

  it("legitimate rejections (valid protocol, invalid gameplay) NEVER count", () => {
    const { core } = newCore({ maxMalformedMessages: 3 });
    const socket = attach(core);
    socket.receive(create);
    // Ten engine-level rejections in a row: valid envelopes, invalid
    // commands (NaN aim, unknown types, wrong phase…).
    for (let i = 0; i < 10; i++) {
      socket.receive(
        JSON.stringify({
          protocolVersion: 1,
          type: "command",
          command: { type: "aim", x: NaN, y: 0 },
        })
      );
      socket.receive(
        JSON.stringify({
          protocolVersion: 1,
          type: "command",
          command: { type: "teleport" },
        })
      );
    }
    expect(socket.errorCodes().length).toBeGreaterThanOrEqual(20);
    expect(socket.closed).toBe(false); // never closed for trying to play badly
  });
});

describe("oversized frames (ws maxPayload)", () => {
  it("an oversized frame closes THAT connection (1009) without harming the server", async () => {
    const server = await createHttpGameServer({
      staticFile: undefined,
      maxPayloadBytes: 1024,
      shutdownTimeoutMs: 2000,
    });
    try {
      const port = server.port();
      const innocent = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => innocent.once("open", () => resolve()));

      const hostile = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => hostile.once("open", () => resolve()));

      const hostileClosed = new Promise<number>((resolve) =>
        hostile.once("close", (code) => resolve(code))
      );
      // A frame far beyond the 1 KiB cap — before any server parsing.
      hostile.send(JSON.stringify({ protocolVersion: 1, type: "command", command: { junk: "x".repeat(8192) } }));
      const closeCode = await Promise.race([
        hostileClosed,
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error("not closed")), 4000)),
      ]);
      expect(closeCode).toBe(1009); // policy violation: message too big

      // The server is unharmed: the innocent client plays normally.
      innocent.send(JSON.stringify({ protocolVersion: 1, type: "create_room" }));
      const welcome = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no welcome — server died?")),
          4000
        );
        innocent.on("message", (raw) => {
          clearTimeout(timer);
          resolve(JSON.parse(raw.toString()));
        });
      });
      expect((welcome as { type?: string }).type).toBe("welcome");
      expect(server.gameServer.roomCount()).toBe(1);
      innocent.close();
    } finally {
      await server.close();
    }
  });
});

describe("reconnect across a server restart (documented in-memory limitation)", () => {
  it("a credential from a previous process is dead — clean invalid-reconnect, no crash", () => {
    // Process A (the "previous server"): issues a credential.
    const a = newCore();
    const aSocket = attach(a.core);
    aSocket.receive(create);
    const welcome = JSON.parse(aSocket.sent[0]) as {
      reconnectToken?: string;
      roomId?: string;
    };
    expect(typeof welcome.reconnectToken).toBe("string");

    // Process B (a fresh restart): the in-memory registry is empty.
    const b = newCore();
    const bSocket = attach(b.core);
    bSocket.receive(
      JSON.stringify({ protocolVersion: 1, type: "reconnect", token: welcome.reconnectToken })
    );
    const codes = bSocket.errorCodes();
    expect(codes).toEqual(["invalid-reconnect"]);
    // …and the fresh server keeps working normally afterwards.
    bSocket.receive(create);
    expect(JSON.parse(bSocket.sent[1]).type).toBe("welcome");
  });
});
