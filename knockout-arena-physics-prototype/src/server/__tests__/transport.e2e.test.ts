import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import {
  createGameServer,
  createWebSocketTransport,
  type GameServer,
  type WebSocketTransport,
} from "../index";

/**
 * End-to-end transport tests over REAL WebSockets: a genuine `ws` server on
 * an ephemeral port and real clients speaking the JSON protocol over the
 * wire. This validates the ws adapter (framing, buffers, close events) on
 * top of the connection logic that transport.test.ts pins with fakes.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

const liveTransports: WebSocketTransport[] = [];
const liveServers: GameServer[] = [];
const openClients: WebSocket[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    client.on("error", () => {}); // teardown noise
    try {
      if (client.readyState === WebSocket.OPEN) client.close();
      else client.terminate();
    } catch {
      // already dead
    }
  }
  for (const transport of liveTransports.splice(0)) {
    await transport.close();
  }
  for (const server of liveServers.splice(0)) {
    server.destroy();
  }
});

/** A connected ws client with a FIFO message queue (open and ready). */
async function connectClient(port: number): Promise<{
  socket: WebSocket;
  /** Resolve the next unconsumed message of the given type (skips others). */
  next<T = Record<string, unknown>>(type?: string, timeoutMs?: number): Promise<T>;
  send(message: unknown): void;
  close(): void;
  received: Array<Record<string, unknown>>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  openClients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (err) => reject(err));
  });

  const received: Array<Record<string, unknown>> = [];
  const pending: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    type?: string;
    resolve: (message: Record<string, unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    received.push(message);
    const index = waiters.findIndex(
      (w) => w.type === undefined || w.type === message.type
    );
    if (index !== -1) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      pending.push(message);
    }
  });

  return {
    socket,
    received,
    async next<T = Record<string, unknown>>(type?: string, timeoutMs = 3000): Promise<T> {
      const index =
        type !== undefined
          ? pending.findIndex((m) => m.type === type)
          : pending.length > 0
            ? 0
            : -1;
      if (index !== -1) return pending.splice(index, 1)[0] as T;
      return new Promise<T>((resolve, reject) => {
        const waiter = {
          type,
          resolve: resolve as (message: Record<string, unknown>) => void,
          timer: setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i !== -1) waiters.splice(i, 1);
            reject(new Error(`timed out waiting for message type ${type ?? "any"}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    send(message: unknown) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
}

/** Start a transport with an injected game server (so tests can inspect it). */
async function startTransport(
  options?: { reconnectReservationMs?: number }
): Promise<WebSocketTransport> {
  const gameServer = createGameServer({
    reconnectReservationMs: options?.reconnectReservationMs,
  });
  liveServers.push(gameServer);
  const transport = await createWebSocketTransport({ gameServer });
  liveTransports.push(transport);
  return transport;
}

const msg = {
  create: { protocolVersion: 1, type: "create_room" },
  start: { protocolVersion: 1, type: "start_match" },
};
const command = (command: unknown) => ({ protocolVersion: 1, type: "command", command });

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// ────────────────────────────────────────────────────────────────────────

describe("WebSocket transport over real sockets", () => {
  it("each real connection becomes exactly one session; a drop reserves it, expiry removes it", async () => {
    const transport = await startTransport({ reconnectReservationMs: 60 });
    const a = await connectClient(transport.port());
    const b = await connectClient(transport.port());
    a.send(msg.create);
    await a.next("welcome");
    b.send(msg.create);
    await b.next("welcome");
    expect(transport.gameServer.sessionCount()).toBe(2);

    // A dropped connection that held a seat: the session SURVIVES (its
    // seat is reserved for the reconnect window)…
    a.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.gameServer.sessionCount()).toBe(2);
    // …until the reservation expires, then it is really gone.
    expect(await waitFor(() => transport.gameServer.sessionCount() === 1, 3000)).toBe(true);
    b.close();
    expect(await waitFor(() => transport.gameServer.sessionCount() === 0, 3000)).toBe(true);
  });

  it("serves the full room flow: create, join, start, command, snapshot", async () => {
    const transport = await startTransport();
    const host = await connectClient(transport.port());
    const guest = await connectClient(transport.port());

    host.send(msg.create);
    const welcome = await host.next("welcome");
    const roomId = welcome.roomId as string;
    expect(welcome).toMatchObject({
      protocolVersion: 1,
      playerId: "p0",
      roomState: "waiting",
      hostPlayerId: "p0",
    });
    await host.next("room_state"); // initial room state (waiting, p0 only)

    guest.send({ protocolVersion: 1, type: "join_room", roomId });
    const guestWelcome = await guest.next("welcome");
    expect(guestWelcome).toMatchObject({ playerId: "p1", roomId });
    await guest.next("room_state"); // the join broadcast the guest itself gets
    await host.next("room_state"); // …and the one the creator receives

    host.send(msg.start);
    const roomState = await host.next("room_state");
    expect(roomState).toMatchObject({ roomState: "playing" });
    await guest.next("room_state");

    // Both receive their own viewer-projected snapshot.
    const [hostSnap, guestSnap] = await Promise.all([
      host.next("snapshot"),
      guest.next("snapshot"),
    ]);
    const hostView = hostSnap.state as GameStateSnapshot;
    const guestView = guestSnap.state as GameStateSnapshot;
    expect(hostView.localPawnId).toBe("p0");
    expect(guestView.localPawnId).toBe("p1");
    expect(hostView.pawns).toHaveLength(2);

    // A command with a forged playerId is applied as the sender's own.
    host.send(command({ type: "aim", playerId: "p1", x: CX, y: CY }));
    const aimSnap = (await host.next("snapshot")).state as GameStateSnapshot;
    expect(aimSnap.isAiming).toBe(true); // the host's OWN aim (viewer-local)
    expect(aimSnap.localPawnId).toBe("p0");
    await guest.next("snapshot");
  }, 8000);

  it("rejects malformed wire input without dropping the connection", async () => {
    const transport = await startTransport();
    const client = await connectClient(transport.port());

    client.socket.send("{this is not json");
    expect(await client.next("error")).toMatchObject({ code: "malformed-message" });

    client.socket.send("null");
    expect(await client.next("error")).toMatchObject({ code: "malformed-message" });

    client.send({ protocolVersion: 99, type: "create_room" });
    expect(await client.next("error")).toMatchObject({ code: "unsupported-protocol" });

    client.send({ protocolVersion: 1, type: "explode" });
    expect(await client.next("error")).toMatchObject({ code: "unknown-message-type" });

    // Still fully usable.
    client.send(msg.create);
    expect(await client.next("welcome")).toMatchObject({ playerId: "p0" });
  });

  it("disconnecting a player notifies the remaining players", async () => {
    const transport = await startTransport();
    const host = await connectClient(transport.port());
    const guest = await connectClient(transport.port());
    host.send(msg.create);
    const { roomId } = (await host.next("welcome")) as { roomId: string };
    await host.next("room_state"); // initial room state (waiting, p0 only)
    guest.send({ protocolVersion: 1, type: "join_room", roomId });
    await guest.next("welcome");
    await host.next("room_state"); // join notification (waiting, p0+p1)

    guest.close();
    const update = await host.next("room_state");
    // The dropped player's seat is RESERVED: still listed (occupied, not
    // stealable) but reported disconnected, and the guest's session is
    // alive for the reconnect window.
    expect(update.roster).toEqual([
      { playerId: "p0", connected: true },
      { playerId: "p1", connected: false },
    ]);
    expect(transport.gameServer.getRoom(roomId)!.seats).toHaveLength(2);
    expect(transport.gameServer.sessionCount()).toBe(2);
  });

  it("runs a whole match to match_finished over the wire", async () => {
    const transport = await startTransport();
    const host = await connectClient(transport.port());
    const guest = await connectClient(transport.port());
    host.send(msg.create);
    const { roomId } = (await host.next("welcome")) as { roomId: string };
    guest.send({ protocolVersion: 1, type: "join_room", roomId });
    await guest.next("welcome");
    host.send(msg.start);
    const snap = await host.next("snapshot");
    const me = (snap.state as GameStateSnapshot).pawns[0];
    const dx = me.position.x - CX || 1;
    const dy = me.position.y - CY;
    const len = Math.hypot(dx, dy) || 1;

    // The host eliminates itself; the guest must be declared the winner.
    host.send(command({ type: "aim", x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 }));
    host.send(command({ type: "setPower", power: 5 }));
    host.send(command({ type: "confirmLaunch" }));
    // Wire commands are asynchronous — wait until the confirmation is
    // visible in the authoritative state before firing the deadline.
    const waitForSnapshot = async (
      predicate: (s: GameStateSnapshot) => boolean
    ): Promise<void> => {
      for (;;) {
        const snap = (await host.next("snapshot")).state as GameStateSnapshot;
        if (predicate(snap)) return;
      }
    };
    await waitForSnapshot((snap) => snap.pawns[0].confirmed === true);
    // The guest stayed silent — the round resolves at the server's
    // decision deadline (the privileged resolveRound path, not the wire).
    transport.gameServer.resolveRound(roomId);
    const finished = await guest.next("match_finished", 6000);
    expect(finished).toMatchObject({ protocolVersion: 1, type: "match_finished", winnerId: "p1" });
    expect(transport.gameServer.getRoom(roomId)!.state).toBe("finished");
  }, 10000);

  it("closing the transport disconnects everyone cleanly", async () => {
    const transport = await startTransport();
    const client = await connectClient(transport.port());
    client.send(msg.create);
    await client.next("welcome");
    expect(transport.gameServer.sessionCount()).toBe(1);

    await transport.close();
    await transport.close(); // idempotent
    expect(transport.gameServer.sessionCount()).toBe(0);
    expect(transport.gameServer.roomCount()).toBe(0);
  });
});
