import { act, cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import {  createNetworkClient,
  type NetworkClient,
} from "../network/websocketClient";
import type { WebSocketFactory, WebSocketLike } from "../network/types";
import { NetworkProvider } from "../network/react";
import { Lobby } from "../components/lobby/Lobby";
import {
  createGameServer,
  createTransportCore,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../../server";

/**
 * Shared harness for the lobby UI tests.
 *
 * Two flavors:
 *   - REAL server: in-memory socket pairs (the Task 6 integration pattern)
 *     into a genuine createTransportCore + createGameServer + engine stack,
 *     so UI actions travel the actual protocol and the actual
 *     authorization rules answer.
 *   - SCRIPTED sockets: hand-driven fakes with no server at all, for pure
 *     UI-state scenarios (connecting, starting…, finished) where we want to
 *     control message timing precisely.
 *
 * Everything renders in jsdom (set per test file via the
 * @vitest-environment docblock); no real network, no canvas.
 */

// React act() support for a non-global test setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The game canvas needs ResizeObserver (jsdom ships none).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
}

// ── the in-memory socket pair ────────────────────────────────────────────

/** One connection: browser end ↔ server end, synchronous delivery. */
export class SocketPair {
  readonly clientEnd: WebSocketLike;
  readonly serverEnd: TransportSocket;
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
        // unused: the close path covers teardown
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
        return 0;
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

  /** The handshake completes. */
  open(): void {
    for (const cb of [...this.openCbs]) cb();
  }

  private kill(): void {
    if (this.dead) return;
    this.dead = true;
    for (const cb of [...this.clientCloseCbs]) cb();
    for (const cb of [...this.serverCloseCbs]) cb();
  }
}

// ── harness: one REAL server, N browser clients ──────────────────────────

const liveClients: NetworkClient[] = [];
const liveCores: TransportCore[] = [];
const liveServers: GameServer[] = [];

afterEach(() => {
  cleanup(); // unmount React trees (no vitest globals → manual cleanup)
  for (const client of liveClients.splice(0)) client.close();
  for (const core of liveCores.splice(0)) core.close();
  for (const server of liveServers.splice(0)) server.destroy();
});

/** A real server stack; add players with addPlayer(). */
export function createServerHarness(
  options?: {
    reconnectReservationMs?: number;
    /** Round decision deadline forwarded to the real game server. */
    roundDecisionTimeoutMs?: number;
  },
  /** Per-player client overrides (e.g. a slower reconnect policy). */
  playerOptions?: { reconnect?: Record<string, unknown> }
) {
  const gameServer = createGameServer({
    reconnectReservationMs: options?.reconnectReservationMs,
    roundDecisionTimeoutMs: options?.roundDecisionTimeoutMs,
  });
  const core = createTransportCore(gameServer);
  liveServers.push(gameServer);
  liveCores.push(core);

  function addPlayer(): { client: NetworkClient; pairs: SocketPair[] } {
    const pairs: SocketPair[] = [];
    const factory: WebSocketFactory = () => {
      const pair = new SocketPair();
      core.attach(pair.serverEnd);
      pairs.push(pair);
      return pair.clientEnd;
    };
    const client = createNetworkClient({
      url: "ws://test",
      socketFactory: factory,
      reconnect: { baseDelayMs: 1, ...playerOptions?.reconnect },
    });
    liveClients.push(client);
    return { client, pairs };
  }

  return { gameServer, core, addPlayer };
}

/** Render the lobby (initial screen) for one player's client. */
export function renderLobby(client: NetworkClient) {
  return render(
    <NetworkProvider client={client}>
      <Lobby onPracticeSolo={() => {}} />
    </NetworkProvider>
  );
}

/** Connect a player's client and complete the (in-memory) handshake. */
export async function connectPlayer(player: {
  client: NetworkClient;
  pairs: SocketPair[];
}): Promise<SocketPair> {
  await act(async () => {
    player.client.connect();
  });
  const pair = player.pairs[0];
  await act(async () => {
    pair.open();
  });
  return pair;
}

/** Drive a player not backed by a rendered UI (act-wrapped store updates). */
export async function playerAct(action: () => void): Promise<void> {
  await act(async () => {
    action();
  });
}

/** The last message a player put on the wire, parsed. */
export function lastSent(pair: SocketPair): Record<string, unknown> {
  const raw = pair.clientSent[pair.clientSent.length - 1];
  if (raw === undefined) throw new Error("nothing was sent on the wire");
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── harness: scripted sockets, no server ─────────────────────────────────

/** A fully controllable fake socket: the test IS the server. */
export class ScriptedSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private openCbs: Array<() => void> = [];
  private messageCbs: Array<(data: string) => void> = [];
  private closeCbs: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    for (const cb of [...this.closeCbs]) cb();
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCbs.push(cb);
  }
  onError(): void {
    // unused
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  serverOpen(): void {
    for (const cb of [...this.openCbs]) cb();
  }
  serverMessage(raw: string): void {
    for (const cb of [...this.messageCbs]) cb(raw);
  }
}

/** A client over scripted sockets (one per connect; index 0 pre-created). */
export function createScriptedClient(): {
  client: NetworkClient;
  sockets: ScriptedSocket[];
} {
  const sockets: ScriptedSocket[] = [];
  const client = createNetworkClient({
    url: "ws://scripted",
    socketFactory: () => {
      const socket = new ScriptedSocket();
      sockets.push(socket);
      return socket;
    },
    reconnect: { enabled: false },
  });
  liveClients.push(client);
  return { client, sockets };
}

// ── wire message builders (the server side of protocol v1) ───────────────

export const wire = {
  welcome: (
    playerId: string,
    roomId: string,
    roster: Array<{ playerId: string; connected: boolean }> = [
      { playerId, connected: true },
    ],
    hostPlayerId: string | null = "p0"
  ) =>
    JSON.stringify({
      protocolVersion: 1,
      type: "welcome",
      roomId,
      playerId,
      roomState: "waiting",
      roster,
      hostPlayerId,
    }),
  roomState: (
    roomState: "waiting" | "playing" | "finished",
    roster: Array<{ playerId: string; connected: boolean }>,
    hostPlayerId: string | null = "p0"
  ) =>
    JSON.stringify({
      protocolVersion: 1,
      type: "room_state",
      roomId: "r1",
      roomState,
      roster,
      hostPlayerId,
    }),
  matchFinished: (winnerId: string | null) =>
    JSON.stringify({ protocolVersion: 1, type: "match_finished", winnerId }),
  /**
   * A snapshot message. `overrides` replaces top-level fields; pawns can be
   * supplied wholesale or per-pawn overrides applied to the defaults by id.
   */
  snapshot: (
    overrides: Record<string, unknown> = {},
    pawnOverrides: Record<string, Record<string, unknown>> = {}
  ) => {
    const defaultPawns = [
      pawn("p0", { isLocal: true }),
      pawn("p1", {}),
    ];
    const pawns =
      (overrides.pawns as unknown[] | undefined)?.map((p, i) =>
        pawn(`p${i}`, p as Record<string, unknown>)
      ) ?? defaultPawns.map((p) =>
        pawnOverrides[p.id] ? { ...p, ...pawnOverrides[p.id] } : p
      );
    const state = {
      phase: "aiming",
      localPawnId: "p0",
      winnerId: null,
      power: 3,
      aimDirection: { x: 1, y: 0 },
      isAiming: false,
      ...overrides,
      pawns,
    };
    return JSON.stringify({ protocolVersion: 1, type: "snapshot", state });
  },
};

/** One pawn snapshot with sane defaults. */
function pawn(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Player ${Number(id.slice(1)) + 1}`,
    position: { x: 300 + Number(id.slice(1)) * 300, y: 350 },
    velocity: { x: 0, y: 0 },
    radius: 16,
    eliminated: false,
    confirmed: false,
    isLocal: false,
    colorIndex: Number(id.slice(1)),
    ...overrides,
  };
}
