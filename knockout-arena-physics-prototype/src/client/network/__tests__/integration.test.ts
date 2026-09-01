import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../../game";
import {
  createGameServer,
  createTransportCore,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../../../server";
import { createNetworkClient, type NetworkClient } from "../websocketClient";
import type { WebSocketFactory, WebSocketLike } from "../types";

/**
 * Full-loop integration: the REAL browser-side network client, driven
 * through in-memory socket pairs into the REAL server stack
 * (createTransportCore + createGameServer + the actual engine).
 *
 * This is the only client-side module allowed to import src/server — it is
 * a Node test, never bundled. It pins the two ends of protocol v1 against
 * each other: what the client builds must be what the server parses, and
 * what the server sends must update the client state and notify its
 * subscribers. No real network, no React, no DOM.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

// ── the in-memory socket pair ────────────────────────────────────────────

/**
 * One connection: a client end (WebSocketLike — what the browser client
 * sees) wired straight to a server end (TransportSocket — what the
 * transport sees). Delivery is synchronous; `open()` plays the handshake.
 */
class SocketPair {
  readonly clientEnd: WebSocketLike;
  readonly serverEnd: TransportSocket;
  /** Everything the client put on the wire (for wire-level assertions). */
  readonly clientSent: string[] = [];
  private openCbs: Array<() => void> = [];
  private clientMessageCbs: Array<(data: string) => void> = [];
  private clientCloseCbs: Array<() => void> = [];
  private serverMessageCbs: Array<(data: string) => void> = [];
  private serverCloseCbs: Array<() => void> = [];
  private serverErrorCbs: Array<(error: unknown) => void> = [];
  private dead = false;

  constructor() {
    this.clientEnd = {
      send: (data) => {
        this.clientSent.push(data);
        for (const cb of [...this.serverMessageCbs]) cb(data);
      },
      close: () => this.kill(),
      onOpen: (cb) => {
        this.openCbs.push(cb);
      },
      onMessage: (cb) => {
        this.clientMessageCbs.push(cb);
      },
      onError: () => {
        // unused in these scenarios: the close path covers teardown
      },
      onClose: (cb) => {
        this.clientCloseCbs.push(cb);
      },
    };
    this.serverEnd = {
      send: (data) => {
        if (this.dead) return;
        for (const cb of [...this.clientMessageCbs]) cb(data);
      },
      get bufferedAmount() {
        return 0; // in-memory: never backpressured
      },
      onMessage: (cb) => {
        this.serverMessageCbs.push(cb);
      },
      onClose: (cb) => {
        this.serverCloseCbs.push(cb);
      },
      onError: (cb) => {
        this.serverErrorCbs.push(cb);
      },
      close: () => this.kill(),
    };
  }

  /** The handshake completes (the network comes up). */
  open(): void {
    for (const cb of [...this.openCbs]) cb();
  }

  /** The connection dies under both ends (an unexpected drop). */
  private kill(): void {
    if (this.dead) return;
    this.dead = true;
    for (const cb of [...this.clientCloseCbs]) cb();
    for (const cb of [...this.serverCloseCbs]) cb();
  }
}

// ── harness ──────────────────────────────────────────────────────────────

const liveClients: NetworkClient[] = [];
const liveCores: TransportCore[] = [];
const liveServers: GameServer[] = [];

afterEach(() => {
  for (const client of liveClients.splice(0)) client.close();
  for (const core of liveCores.splice(0)) core.close();
  for (const server of liveServers.splice(0)) server.destroy();
});

/** A real transport core around a real game server. */
function makeCore(): TransportCore {
  const gameServer = createGameServer();
  liveServers.push(gameServer);
  const core = createTransportCore(gameServer);
  liveCores.push(core);
  return core;
}

/**
 * A browser client whose sockets are in-memory pairs, each automatically
 * attached to the core (exactly what a real server does per connection).
 * Each new socket completes its handshake by itself on the next tick —
 * a real WebSocket fires `open` without the caller's help.
 */
function makeBrowserClient(
  core: TransportCore,
  reconnect: Record<string, unknown> = { baseDelayMs: 1 }
): { client: NetworkClient; pairs: SocketPair[]; factory: WebSocketFactory } {
  const pairs: SocketPair[] = [];
  const factory: WebSocketFactory = () => {
    const pair = new SocketPair();
    core.attach(pair.serverEnd);
    pairs.push(pair);
    setTimeout(() => pair.open(), 0);
    return pair.clientEnd;
  };
  const client = createNetworkClient({
    url: "ws://integration",
    socketFactory: factory,
    reconnect,
  });
  liveClients.push(client);
  return { client, pairs, factory };
}

/** Connect + wait for the (self-completing) handshake. */
async function connect(
  core: TransportCore,
  reconnect?: Record<string, unknown>
): Promise<{ client: NetworkClient; pair: SocketPair; pairs: SocketPair[] }> {
  const harness = makeBrowserClient(core, reconnect);
  harness.client.connect();
  await new Promise((r) => setTimeout(r, 5));
  expect(harness.client.getState().status).toBe("connected");
  return { client: harness.client, pair: harness.pairs[0], pairs: harness.pairs };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

/** Drive two clients into one started, playing room. */
async function startedRoom(core: TransportCore): Promise<{
  host: Awaited<ReturnType<typeof connect>>;
  guest: Awaited<ReturnType<typeof connect>>;
}> {
  const host = await connect(core);
  const guest = await connect(core);
  host.client.createRoom();
  const roomId = host.client.getState().roomId as string;
  guest.client.joinRoom(roomId);
  host.client.startMatch();
  return { host, guest };
}

// ────────────────────────────────────────────────────────────────────────

describe("browser client ↔ real server (in-memory wire)", () => {
  it("serves the full room flow and projects each client's own view", async () => {
    const core = makeCore();
    const host = await connect(core);
    const guest = await connect(core);

    // The host creates the room and is seated p0 (server-assigned).
    expect(host.client.createRoom()).toBe(true);
    const hostState = host.client.getState();
    const roomId = hostState.roomId as string;
    expect(roomId).toBeTruthy();
    expect(hostState.playerId).toBe("p0");
    expect(hostState.hostPlayerId).toBe("p0");
    expect(hostState.roomState).toBe("waiting");
    expect(hostState.roster).toEqual([{ playerId: "p0", connected: true }]);

    // The guest joins and is seated p1; the host sees the roster grow.
    expect(guest.client.joinRoom(roomId)).toBe(true);
    const guestState = guest.client.getState();
    expect(guestState.roomId).toBe(roomId);
    expect(guestState.playerId).toBe("p1");
    expect(guestState.hostPlayerId).toBe("p0");
    expect(host.client.getState().roster).toHaveLength(2);

    // Only the host may start the match.
    expect(guest.client.startMatch()).toBe(true); // sent (connected)…
    expect(guest.client.getState().lastError?.code).toBe("unauthorized");
    expect(host.client.startMatch()).toBe(true);
    expect(host.client.getState().roomState).toBe("playing");
    expect(guest.client.getState().roomState).toBe("playing");

    // Snapshots arrive and each client sees ITS OWN pawn as local.
    expect(
      await waitFor(
        () =>
          host.client.getState().snapshot !== null &&
          guest.client.getState().snapshot !== null,
        3000
      )
    ).toBe(true);
    const hostView = host.client.getState().snapshot as GameStateSnapshot;
    const guestView = guest.client.getState().snapshot as GameStateSnapshot;
    expect(hostView.localPawnId).toBe("p0");
    expect(guestView.localPawnId).toBe("p1");
    expect(hostView.pawns).toHaveLength(2);
    expect(guestView.pawns).toHaveLength(2);

    // A command with a forged playerId is applied to the SENDER's pawn —
    // identity comes from the session, and the client never sends one.
    expect(
      host.client.submitCommand({ type: "aim", playerId: "p1", x: CX, y: CY })
    ).toBe(true);
    expect(
      await waitFor(
        () => (host.client.getState().snapshot as GameStateSnapshot).isAiming === true,
        3000
      )
    ).toBe(true);
    const aiming = host.client.getState().snapshot as GameStateSnapshot;
    expect(aiming.activePawnId).toBe("p0"); // the host aimed its own pawn
    for (const raw of host.pair.clientSent) {
      expect(JSON.parse(raw)).not.toHaveProperty("playerId");
      expect(JSON.parse(raw).command ?? {}).not.toHaveProperty("playerId");
    }
  });

  it("runs a real match to match_finished: the self-KO player loses", async () => {
    const core = makeCore();
    const { host, guest } = await startedRoom(core);

    expect(
      await waitFor(() => host.client.getState().snapshot !== null, 3000)
    ).toBe(true);
    const me = (host.client.getState().snapshot as GameStateSnapshot).pawns.find(
      (pawn) => pawn.id === "p0"
    ) as GameStateSnapshot["pawns"][number];
    const dx = me.position.x - CX || 1;
    const dy = me.position.y - CY;
    const len = Math.hypot(dx, dy) || 1;

    // The host launches itself out of the arena; the guest must win.
    expect(
      host.client.submitCommand({
        type: "aim",
        x: CX + (dx / len) * 400,
        y: CY + (dy / len) * 400,
      })
    ).toBe(true);
    host.client.submitCommand({ type: "setPower", power: 5 });
    host.client.submitCommand({ type: "confirmLaunch" });

    const finished = await waitFor(
      () => host.client.getState().winnerId === "p1" && guest.client.getState().winnerId === "p1",
      6000
    );
    expect(finished).toBe(true);
    expect(host.client.getState().roomState).toBe("finished");
    expect(guest.client.getState().roomState).toBe("finished");
    const finalView = host.client.getState().snapshot as GameStateSnapshot;
    expect(finalView.phase).toBe("finished");
  }, 10000);

  it("joining an unknown room surfaces the server error without breaking the client", async () => {
    const core = makeCore();
    const { client } = await connect(core);

    expect(client.joinRoom("room-that-does-not-exist")).toBe(true);
    const state = client.getState();
    expect(state.lastError?.code).toBe("unknown-room");
    expect(state.roomId).toBeNull();
    expect(state.status).toBe("connected");

    // The connection stays fully usable afterwards.
    expect(client.createRoom()).toBe(true);
    expect(client.getState().roomId).toBeTruthy();
    expect(client.getState().playerId).toBe("p0");
  });

  it("an unexpected drop reconnects as a fresh session — the old seat is not restored", async () => {
    const core = makeCore();
    const { client, pair } = await connect(core);
    client.createRoom();
    expect(client.getState().roomId).toBeTruthy();

    pair.serverEnd.close(); // the network drops us mid-room
    expect(client.getState().status).toBe("reconnecting");
    expect(client.getState().roomId).toBeNull(); // no pretending

    const reconnected = await waitFor(
      () => client.getState().status === "connected",
      3000
    );
    expect(reconnected).toBe(true);
    // Fresh session: no room, no seat — and no automatic room creation.
    expect(client.getState().roomId).toBeNull();
    expect(client.getState().playerId).toBeNull();
    // …but fully usable again.
    expect(client.createRoom()).toBe(true);
    expect(client.getState().playerId).toBe("p0");
  });

  it("an explicit client close tears the server session down", async () => {
    const core = makeCore();
    const gameServer = liveServers[liveServers.length - 1];
    const { client } = await connect(core);
    client.createRoom();

    client.close();
    expect(client.getState().status).toBe("closed");
    expect(await waitFor(() => gameServer.sessionCount() === 0, 3000)).toBe(true);
  });

  it("subscribers are notified as the state flows through a real match", async () => {
    const core = makeCore();
    const host = await connect(core);
    const guest = await connect(core);
    host.client.createRoom();

    let notifications = 0;
    const unsubscribe = host.client.subscribe(() => {
      notifications += 1;
    });

    // The guest joins → the host's roster/room state change → notification.
    guest.client.joinRoom(host.client.getState().roomId as string);
    expect(notifications).toBeGreaterThan(0);
    expect(host.client.getState().roster).toHaveLength(2);
    const afterJoin = notifications;

    // Starting the match changes room state and delivers a snapshot.
    host.client.startMatch();
    expect(
      await waitFor(() => host.client.getState().snapshot !== null, 3000)
    ).toBe(true);
    expect(notifications).toBeGreaterThan(afterJoin);
    const afterStart = notifications;

    // Unsubscribed: no further notifications. (The guest's rejected command
    // errors on the GUEST side only — the host hears nothing.)
    unsubscribe();
    guest.client.submitCommand({ type: "aim", x: CX, y: CY });
    expect(notifications).toBe(afterStart);
    expect(guest.client.getState().lastError?.code).toBe("wrong-player");
    expect(host.client.getState().lastError).toBeNull();
  });
});
