import { afterEach, describe, expect, it } from "vitest";
import {
  createGameServer,
  createTransportCore,
  type ConnectionHandle,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";
import {
  createReconnectRegistry,
  DEFAULT_EXPIRED_CREDENTIAL_TTL_MS,
  DEFAULT_MAX_EXPIRED_CREDENTIALS,
} from "../reconnect";

/**
 * EXPIRED-RECONNECT FEEDBACK (Task 14).
 *
 * A player who steps away past the reconnect window used to get the same
 * opaque "invalid-reconnect" as someone typing a made-up credential.
 * That is honest but useless: they cannot tell a timeout from a bug.
 *
 * The carve-out is deliberately narrow. When a reservation expires, the
 * credential's DIGEST is tombstoned briefly, so the bearer of that exact
 * token — and nobody else — can be told the seat was released.
 *
 * What these tests pin, in order of importance:
 *
 *   1. SECURITY: a guessed/never-issued credential gets exactly the old
 *      generic answer, with the same response shape; every non-expiry
 *      revocation (leave, force disconnect, teardown, stale) stays
 *      generic too;
 *   2. the tombstone is bounded in time AND size — it must never become
 *      a permanent ledger of every credential ever issued;
 *   3. the expiring bearer gets the specific reason, once, and the wire
 *      carries it through to the client.
 */

const liveServers: GameServer[] = [];
function newServer(options?: {
  reconnectReservationMs?: number;
}): GameServer {
  const server = createGameServer({ randomSkinIndex: () => 0, ...options });
  liveServers.push(server);
  return server;
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/** A room with `n` seated sessions; returns their credentials. */
function makeRoom(server: GameServer, n: number) {
  const sessions = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  if (!created.ok) throw new Error("create failed");
  sessions.push(creator);
  tokens.push(created.reconnectToken);
  for (let i = 1; i < n; i += 1) {
    const s = server.connect();
    const joined = server.joinRoom(s, created.room.id);
    if (!joined.ok) throw new Error("join failed");
    sessions.push(s);
    tokens.push(joined.reconnectToken);
  }
  return { roomId: created.room.id, sessions, tokens };
}

/** Seat a player, drop them, and let the reservation lapse. */
async function expiredCredential(reservationMs = 40): Promise<{
  server: GameServer;
  token: string;
}> {
  const server = newServer({ reconnectReservationMs: reservationMs });
  const { sessions, tokens } = makeRoom(server, 2);
  expect(server.reserve(sessions[1]!)).toEqual({ ok: true });
  expect(await waitFor(() => server.sessionCount() === 1, 3000)).toBe(true);
  return { server, token: tokens[1]! };
}

// ────────────────────────────────────────────────────────────────────────
// 1. The security property: nothing new is observable to a guesser
// ────────────────────────────────────────────────────────────────────────

describe("a guessed credential is answered exactly as before", () => {
  it("returns the generic rejection for every shape of junk", async () => {
    // The SAME list the pre-existing uniform-rejection test uses. If any
    // of these ever produced reservation-expired, the carve-out would
    // have become an oracle.
    const { server } = await expiredCredential();
    const junk: unknown[] = [
      "",
      "   ",
      "not-a-real-token",
      "p1",
      123,
      null,
      undefined,
      {},
      [],
      "0".repeat(64),
      "A".repeat(43),
    ];
    for (const token of junk) {
      expect(server.reconnect(token)).toEqual({
        ok: false,
        reason: "invalid-reconnect",
      });
    }
  });

  it("returns the generic rejection even while tombstones exist", async () => {
    // A guesser probing DURING the window in which a real credential is
    // tombstoned must still learn nothing.
    const { server } = await expiredCredential();
    for (let i = 0; i < 50; i += 1) {
      expect(server.reconnect(`guess-${i}`)).toEqual({
        ok: false,
        reason: "invalid-reconnect",
      });
    }
  });

  it("produces an identical response SHAPE for guessed and expired", async () => {
    // Both are {ok:false, reason:string} with the same key set — only
    // the reason string differs, and only for the token's true holder.
    const { server, token } = await expiredCredential();
    const expired = server.reconnect(token);
    const guessed = server.reconnect("definitely-not-issued");
    expect(Object.keys(expired).sort()).toEqual(Object.keys(guessed).sort());
    expect(expired.ok).toBe(false);
    expect(guessed.ok).toBe(false);
  });

  it("adds no timing signal beyond what the digest map already had", async () => {
    // Reasoning, pinned as a test: reaching EITHER differentiated
    // outcome (a live credential, or a tombstoned one) requires already
    // holding the 256-bit token. The pre-existing resolve() hit/miss
    // difference is far larger than anything the tombstone lookup adds,
    // so the carve-out introduces no new oracle CLASS — a guesser still
    // sees only the miss path.
    const server = newServer({ reconnectReservationMs: 40 });
    const { sessions, tokens } = makeRoom(server, 3);
    server.reserve(sessions[1]!);
    expect(await waitFor(() => server.sessionCount() === 2, 3000)).toBe(true);

    const expiredToken = tokens[1]!;
    const validToken = tokens[2]!;
    const fake = "B".repeat(expiredToken.length);

    const bench = (fn: () => void): number => {
      for (let i = 0; i < 2000; i += 1) fn();
      const start = performance.now();
      for (let i = 0; i < 20000; i += 1) fn();
      return performance.now() - start;
    };

    const guessed = bench(() => void server.reconnect(fake));
    const expired = bench(() => void server.reconnect(expiredToken));
    // A VALID credential resolves on the first map and returns early —
    // a much bigger timing difference, present since long before this
    // task. (Measured once; it re-seats the session, so it is not benched.)
    expect(server.reconnect(validToken).ok).toBe(true);

    // The tombstone path must stay in the same order of magnitude as the
    // plain miss it replaces; it must not become dramatically slower.
    expect(expired).toBeLessThan(guessed * 3);
    expect(guessed).toBeGreaterThan(0);
  });

  it("never reveals a seat, room or session in the expiry rejection", async () => {
    const { server, token } = await expiredCredential();
    const result = server.reconnect(token);
    expect(result).toEqual({ ok: false, reason: "reservation-expired" });
    // No room id, player id or session smuggled alongside the reason.
    expect(JSON.stringify(result)).not.toMatch(/p\d|room|session|token/i);
  });

  it("keeps every NON-expiry revocation generic", async () => {
    // Only a lapsed reservation may differentiate. A clean leave, a
    // force disconnect and a server teardown must all stay opaque —
    // otherwise the reason code would leak whether a token ever existed.
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 3);

    // (a) force disconnect
    server.disconnect(sessions[1]!);
    expect(server.reconnect(tokens[1]!)).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });

    // (b) explicit leave
    server.leaveRoom(sessions[2]!);
    expect(server.reconnect(tokens[2]!)).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });

    // (c) teardown
    expect(roomId).toBeTruthy();
    server.destroy();
    expect(server.reconnect(tokens[0]!)).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
  });

  it("keeps a still-valid reservation's rejections generic", () => {
    // The window is OPEN here: presenting junk, or a credential whose
    // session was superseded, must not hint at the live reservation.
    const server = newServer({ reconnectReservationMs: 10_000 });
    const { sessions, tokens } = makeRoom(server, 2);
    expect(server.reserve(sessions[1]!)).toEqual({ ok: true });

    expect(server.reconnect("junk-while-reserved")).toEqual({
      ok: false,
      reason: "invalid-reconnect",
    });
    // The real credential still WORKS (it has not expired).
    expect(server.reconnect(tokens[1]!).ok).toBe(true);
  });

  it("does not tombstone a credential that reconnected in time", async () => {
    const server = newServer({ reconnectReservationMs: 300 });
    const { sessions, tokens } = makeRoom(server, 2);
    server.reserve(sessions[1]!);
    expect(server.reconnect(tokens[1]!).ok).toBe(true); // back in time

    // Wait past the ORIGINAL window: the credential is still live, and
    // nothing was tombstoned, because the reservation never expired.
    await sleep(500);
    expect(server.reconnect(tokens[1]!).ok).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. The tombstone is bounded — no permanent ledger
// ────────────────────────────────────────────────────────────────────────

describe("the tombstone is bounded in time and size", () => {
  it("reverts to the generic rejection once the TTL lapses", () => {
    // Registry-level, so the TTL can be tiny without touching the
    // reconnect window (which this task must not change).
    const registry = createReconnectRegistry({ expiredTtlMs: 40 });
    const raw = registry.issue("session-1", "room-1", "p0");
    registry.expireSession("session-1");

    expect(registry.wasExpired(raw)).toBe(true);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(registry.wasExpired(raw)).toBe(false);
        expect(registry.expiredSize()).toBe(0);
        resolve();
      }, 80);
    });
  });

  it("evicts the oldest tombstones past the cap", () => {
    const registry = createReconnectRegistry({ maxExpiredEntries: 4 });
    const tokens: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      tokens.push(registry.issue(`s${i}`, "room", "p0"));
      registry.expireSession(`s${i}`);
    }
    // Bounded: never a record of all ten.
    expect(registry.expiredSize()).toBeLessThanOrEqual(4);
    // The oldest are forgotten (back to generic); the newest are known.
    expect(registry.wasExpired(tokens[0]!)).toBe(false);
    expect(registry.wasExpired(tokens[9]!)).toBe(true);
  });

  it("stores only a digest and a timestamp — no seat data", () => {
    const registry = createReconnectRegistry();
    const raw = registry.issue("session-secret", "room-42", "p3");
    registry.expireSession("session-secret");
    // The tombstone answers one boolean question and nothing else: the
    // registry exposes no way to read a room/player back out of it.
    expect(registry.wasExpired(raw)).toBe(true);
    expect(registry.resolve(raw)).toBeNull();
  });

  it("does not resurrect an expired credential as usable", () => {
    const registry = createReconnectRegistry();
    const raw = registry.issue("session-1", "room-1", "p0");
    registry.expireSession("session-1");
    expect(registry.resolve(raw)).toBeNull(); // still dead for seating
    expect(registry.size()).toBe(0);
  });

  it("clear() drops tombstones as well as credentials", () => {
    const registry = createReconnectRegistry();
    const raw = registry.issue("session-1", "room-1", "p0");
    registry.expireSession("session-1");
    registry.clear();
    expect(registry.wasExpired(raw)).toBe(false);
    expect(registry.expiredSize()).toBe(0);
  });

  it("wasExpired rejects non-string input without throwing", () => {
    const registry = createReconnectRegistry();
    for (const bad of [null, undefined, 0, {}, [], ""]) {
      expect(registry.wasExpired(bad)).toBe(false);
    }
  });

  it("revokeSession (the non-expiry path) leaves NO tombstone", () => {
    const registry = createReconnectRegistry();
    const raw = registry.issue("session-1", "room-1", "p0");
    registry.revokeSession("session-1");
    expect(registry.wasExpired(raw)).toBe(false);
    expect(registry.expiredSize()).toBe(0);
  });

  it("ships sane defaults", () => {
    // Long enough for a player to read a message and come back; far
    // shorter than "forever".
    expect(DEFAULT_EXPIRED_CREDENTIAL_TTL_MS).toBe(5 * 60_000);
    expect(DEFAULT_MAX_EXPIRED_CREDENTIALS).toBe(1024);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. The bearer gets the message
// ────────────────────────────────────────────────────────────────────────

describe("the player whose window closed is told why", () => {
  it("returns reservation-expired for their own credential", async () => {
    const { server, token } = await expiredCredential();
    expect(server.reconnect(token)).toEqual({
      ok: false,
      reason: "reservation-expired",
    });
  });

  it("is stable across repeated attempts inside the tombstone window", async () => {
    const { server, token } = await expiredCredential();
    for (let i = 0; i < 3; i += 1) {
      expect(server.reconnect(token)).toEqual({
        ok: false,
        reason: "reservation-expired",
      });
    }
  });

  it("reports expiry for a mid-match drop too", async () => {
    const server = newServer({ reconnectReservationMs: 40 });
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    expect(server.reserve(sessions[1]!)).toEqual({ ok: true });
    expect(await waitFor(() => server.sessionCount() === 1, 3000)).toBe(true);
    expect(server.reconnect(tokens[1]!)).toEqual({
      ok: false,
      reason: "reservation-expired",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Over the wire
// ────────────────────────────────────────────────────────────────────────

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
  onError(): void {
    /* fake sockets never error */
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeHandlers) cb();
  }
  receiveMsg(message: unknown): void {
    const data = JSON.stringify(message);
    for (const cb of this.messageHandlers) cb(data);
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  lastOf(type: string): Record<string, unknown> | undefined {
    const all = this.parsed().filter((m) => m.type === type);
    return all[all.length - 1];
  }
}

describe("the reason reaches the client over the wire", () => {
  function newCore(options?: { reconnectReservationMs?: number }): {
    server: GameServer;
    core: TransportCore;
  } {
    const server = newServer(options);
    return { server, core: createTransportCore(server) };
  }
  function connect(core: TransportCore): {
    socket: FakeSocket;
    handle: ConnectionHandle;
  } {
    const socket = new FakeSocket();
    return { socket, handle: core.attach(socket) };
  }

  it("sends a reservation-expired error with a human sentence", async () => {
    const { server, core } = newCore({ reconnectReservationMs: 40 });
    const creator = connect(core);
    creator.socket.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const welcome = creator.socket.lastOf("welcome")!;
    const token = welcome.reconnectToken as string;

    creator.socket.close();
    expect(await waitFor(() => server.sessionCount() === 0, 3000)).toBe(true);

    const late = connect(core).socket;
    late.receiveMsg({ protocolVersion: 1, type: "reconnect", token });
    const error = late.lastOf("error")!;
    expect(error.code).toBe("reservation-expired");
    expect(String(error.message)).toContain("away too long");
    // The sentence must be usable as-is in the UI: no codes, no jargon.
    expect(String(error.message)).not.toMatch(/credential|token|digest/i);
  });

  it("still sends the generic error for a made-up credential", () => {
    const { core } = newCore();
    const socket = connect(core).socket;
    socket.receiveMsg({
      protocolVersion: 1,
      type: "reconnect",
      token: "totally-made-up-credential",
    });
    const error = socket.lastOf("error")!;
    expect(error.code).toBe("invalid-reconnect");
    expect(String(error.message)).toContain("invalid or expired");
  });

  it("leaves the connection usable after either rejection", async () => {
    const { server, core } = newCore({ reconnectReservationMs: 40 });
    const creator = connect(core);
    creator.socket.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const token = creator.socket.lastOf("welcome")!.reconnectToken as string;
    creator.socket.close();
    expect(await waitFor(() => server.sessionCount() === 0, 3000)).toBe(true);

    const late = connect(core).socket;
    late.receiveMsg({ protocolVersion: 1, type: "reconnect", token });
    expect(late.lastOf("error")!.code).toBe("reservation-expired");

    // The player can immediately start over on the same socket.
    late.receiveMsg({ protocolVersion: 1, type: "create_room" });
    expect(late.lastOf("welcome")!.playerId).toBe("p0");
  });
});
