import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import {
  createGameServer,
  createTransportCore,
  type ConnectionHandle,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";

/**
 * ADVERSARIAL protocol suite (Task 21 security audit).
 *
 * Everything here drives the REAL wire path — createTransportCore over
 * fake sockets around a real createGameServer + engine — as a hostile or
 * malformed client would. No facade shortcuts: every attack arrives as a
 * string on a socket, and every assertion inspects actual outbound wire
 * messages.
 *
 * The trust model these tests attack (see README "Trust boundary"):
 *   - identity is the SESSION (server-issued, socket-bound) — a client
 *     never contributes a playerId, seat, host flag or room;
 *   - commands are rebuilt from known fields and stamped with the
 *     session's seat playerId (anything else in the payload is dropped);
 *   - resolveRound / reset are privileged (server-only); start_match is
 *     host-only, checked server-side;
 *   - per-pawn aim/power is structurally absent from every other
 *     viewer's snapshot (only readiness is public during aiming);
 *   - rooms are isolated universes: codes, rosters, snapshots, commands
 *     and credentials never cross rooms;
 *   - reconnect credentials are opaque 256-bit values that resolve to
 *     exactly one seat, appear only in the holder's own welcome, and die
 *     with the seat (leave, force-close, expiry, teardown).
 *
 * Overlaps with the per-module suites are deliberate re-pins at the WIRE
 * level: the existing suites prove each property at the facade/engine
 * level; these prove the same properties survive the full transport path
 * an attacker actually has.
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
  json(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.json().filter(
      (m): m is Record<string, unknown> =>
        typeof m === "object" && m !== null && (m as { type?: unknown }).type === type
    );
  }
  lastOf(type: string): Record<string, unknown> | undefined {
    const all = this.ofType(type);
    return all[all.length - 1];
  }
  /** Outbound viewer-projected snapshots. */
  views(): GameStateSnapshot[] {
    return this.ofType("snapshot").map((m) => m.state as GameStateSnapshot);
  }
  lastView(): GameStateSnapshot | undefined {
    const all = this.views();
    return all[all.length - 1];
  }
  errorCodes(): string[] {
    return this.ofType("error").map((m) => String(m.code));
  }
}

// ── harness ───────────────────────────────────────────────────────────────

const liveServers: GameServer[] = [];
const liveCores: TransportCore[] = [];

function newCore(options?: {
  reconnectReservationMs?: number;
}): { server: GameServer; core: TransportCore } {
  const server = createGameServer({
    reconnectReservationMs: options?.reconnectReservationMs,
  });
  liveServers.push(server);
  const core = createTransportCore(server);
  liveCores.push(core);
  return { server, core };
}
afterEach(() => {
  for (const core of liveCores) core.close();
  liveCores.length = 0;
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function connect(core: TransportCore): { socket: FakeSocket; handle: ConnectionHandle } {
  const socket = new FakeSocket();
  const handle = core.attach(socket);
  return { socket, handle };
}

const wire = {
  create: { protocolVersion: 1, type: "create_room" },
  leave: { protocolVersion: 1, type: "leave_room" },
  start: { protocolVersion: 1, type: "start_match" },
  join: (roomId: string) => ({ protocolVersion: 1, type: "join_room", roomId }),
  reconnect: (token: string) => ({ protocolVersion: 1, type: "reconnect", token }),
  setName: (name: string) => ({ protocolVersion: 1, type: "set_name", name }),
  command: (command: unknown) => ({ protocolVersion: 1, type: "command", command }),
};

function welcomeOf(socket: FakeSocket): Record<string, unknown> {
  const w = socket.lastOf("welcome");
  expect(w).toBeDefined();
  return w as Record<string, unknown>;
}

/** A started 2-player match with named players; creator = host. */
function namedMatch(
  core: TransportCore,
  names: [string, string]
): {
  code: string;
  credentials: [string, string];
  host: FakeSocket;
  guest: FakeSocket;
  hostHandle: ConnectionHandle;
  guestHandle: ConnectionHandle;
} {
  const host = connect(core);
  host.socket.receiveMsg(wire.create);
  const hw = welcomeOf(host.socket) as { roomId: string; reconnectToken: string };
  host.socket.receiveMsg(wire.setName(names[0]));
  const guest = connect(core);
  guest.socket.receiveMsg(wire.join(hw.roomId));
  const gw = welcomeOf(guest.socket) as { roomId: string; reconnectToken: string };
  guest.socket.receiveMsg(wire.setName(names[1]));
  host.socket.receiveMsg(wire.start);
  return {
    code: hw.roomId,
    credentials: [hw.reconnectToken, gw.reconnectToken],
    host: host.socket,
    guest: guest.socket,
    hostHandle: host.handle,
    guestHandle: guest.handle,
  };
}

/** Poll until a condition or fail with the given message. */
async function until(
  pred: () => boolean,
  what: string,
  timeoutMs = 6000
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(pred(), what).toBe(true);
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

/** Radially outward aim target for a pawn (flies over the rim). */
function outwardFrom(p: { x: number; y: number }): { x: number; y: number } {
  const dx = p.x - CX || 1;
  const dy = p.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (dx / len) * 400, y: p.y + (dy / len) * 400 };
}

// ─────────────────────────────────────────────────────────────────────────
// Identity spoofing
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: identity spoofing", () => {
  it("a forged playerId in a command lands on the SENDER's pawn, never the victim's", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    // The host claims to be the guest.
    m.host.receiveMsg(
      wire.command({ type: "aim", playerId: "p1", x: CX + 400, y: CY })
    );

    // The command applied to the SENDER's own pawn (host = p0)…
    const own = m.host.lastView();
    expect(own?.aimDirection).not.toBeNull();
    // …and the victim's own view still shows NO aim of their own…
    const victim = m.guest.lastView();
    expect(victim?.aimDirection).toBeNull();
    expect(victim?.power).toBe(CONFIG.power.default);
    // …and the victim received no error and no confirmation.
    expect(m.guest.errorCodes()).toEqual([]);
    expect(victim?.pawns.find((p) => p.id === "p1")?.confirmed).toBe(false);
  });

  it("hostile command objects (throwing getters, junk shapes) never crash or break the connection", async () => {
    const { server, core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    // JSON can carry none of these finer hostilities — but the transport is
    // not the only caller: the facade boundary must survive them too.
    const facadeHostile: unknown[] = [
      { type: "aim", get x(): number { throw new Error("boom"); }, y: 5 },
      { type: "setPower", get power(): number { throw new Error("boom"); } },
      Object.assign(Object.create(null), { type: "aim", y: 5 }), // no prototype, no x
      new Proxy({ type: "aim", x: 1, y: 1 }, { get(t, k) { return String(Reflect.get(t, k)); } }),
    ];
    for (const payload of facadeHostile) {
      const result = server.submitCommand(m.hostHandle.session, payload);
      expect(result.ok).toBe(false);
    }

    // Over the WIRE, the same family arrives as JSON-encodable junk —
    // every one rejected, the connection unharmed.
    const wireHostile: unknown[] = [null, "aim", 42, [], { type: "aim" }];
    for (const payload of wireHostile) m.host.receiveMsg(wire.command(payload));
    expect(m.host.errorCodes().length).toBe(wireHostile.length);

    // The connection is still fully usable: a valid command goes through.
    m.host.receiveMsg(wire.command({ type: "aim", x: CX + 400, y: CY }));
    expect(m.host.lastView()?.aimDirection).not.toBeNull();
    expect(m.guest.errorCodes()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Room isolation
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: room isolation", () => {
  it("two live matches: no code, name, credential or snapshot ever crosses rooms", async () => {
    const { core } = newCore();
    const a = namedMatch(core, ["AlphaHost", "AlphaGuest"]);
    const b = namedMatch(core, ["BetaHost", "BetaGuest"]);
    await until(
      () => a.host.lastView()?.phase === "aiming" && b.host.lastView()?.phase === "aiming",
      "both matches reach aiming"
    );

    // Room A plays a full decision round…
    const a0 = a.host.lastView()!.pawns.find((p) => p.id === "p0")!;
    const a1 = a.guest.lastView()!.pawns.find((p) => p.id === "p1")!;
    a.host.receiveMsg(wire.command({ type: "aim", x: a0.position.x + 300, y: a0.position.y }));
    a.host.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    a.guest.receiveMsg(wire.command({ type: "aim", x: a1.position.x - 300, y: a1.position.y }));
    a.guest.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    a.host.receiveMsg(wire.command({ type: "confirmLaunch" }));
    a.guest.receiveMsg(wire.command({ type: "confirmLaunch" }));
    await until(() => a.host.lastView()?.phase === "moving", "room A resolves");

    // …and room B sees NOTHING of it.
    const bSockets = [b.host, b.guest];
    for (const socket of bSockets) {
      const raw = socket.sent.join("\n");
      expect(raw).not.toContain(a.code);
      expect(raw).not.toContain("AlphaHost");
      expect(raw).not.toContain("AlphaGuest");
      expect(raw).not.toContain(a.credentials[0]);
      expect(raw).not.toContain(a.credentials[1]);
      expect(raw).not.toMatch(UUID_RE); // internal ids never on the wire
      for (const view of socket.views()) {
        expect(view.phase).toBe("aiming"); // B's round was never resolved
        expect(view.pawns.map((p) => p.name)).toEqual(["BetaHost", "BetaGuest"]);
        expect(view.pawns.every((p) => !p.confirmed)).toBe(true);
      }
    }
  });

  it("commands are room-scoped: room A's resolution never moves room B's pawns", async () => {
    const { core } = newCore();
    const a = namedMatch(core, ["AlphaHost", "AlphaGuest"]);
    const b = namedMatch(core, ["BetaHost", "BetaGuest"]);
    await until(
      () => a.host.lastView()?.phase === "aiming" && b.host.lastView()?.phase === "aiming",
      "both matches reach aiming"
    );
    const bBefore = b.host.lastView()!.pawns.map((p) => ({ ...p.position }));

    const a0 = a.host.lastView()!.pawns.find((p) => p.id === "p0")!;
    const a1 = a.guest.lastView()!.pawns.find((p) => p.id === "p1")!;
    a.host.receiveMsg(wire.command({ type: "aim", x: a0.position.x + 300, y: a0.position.y }));
    a.guest.receiveMsg(wire.command({ type: "aim", x: a1.position.x - 300, y: a1.position.y }));
    a.host.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    a.guest.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    a.host.receiveMsg(wire.command({ type: "confirmLaunch" }));
    a.guest.receiveMsg(wire.command({ type: "confirmLaunch" }));
    await until(() => a.host.lastView()?.phase === "moving", "room A resolves");

    const bAfter = b.host.lastView()!.pawns.map((p) => ({ ...p.position }));
    expect(bAfter).toEqual(bBefore);
    expect(b.host.lastView()!.phase).toBe("aiming");
  });

  it("a room-A credential recovers only room A's seat — never room B's", async () => {
    const { server, core } = newCore();
    const a = namedMatch(core, ["AlphaHost", "AlphaGuest"]);
    const b = namedMatch(core, ["BetaHost", "BetaGuest"]);
    expect(server.roomCount()).toBe(2);

    // Room A's host drops; a fresh connection presents A's credential.
    a.host.close();
    const fresh = connect(core);
    fresh.socket.receiveMsg(wire.reconnect(a.credentials[0]));
    const w = welcomeOf(fresh.socket) as { roomId: string; playerId: string };
    expect(w.roomId).toBe(a.code);
    expect(w.playerId).toBe("p0"); // the credential's own seat, never B's

    // Room B is untouched.
    expect(server.roomCount()).toBe(2);
    expect(b.host.lastView()?.phase).toBe("aiming");
    expect(b.host.sent.join("\n")).not.toContain(a.credentials[0]);
  });

  it("destroying room A leaves room B fully playable", async () => {
    const { server, core } = newCore();
    const a = namedMatch(core, ["AlphaHost", "AlphaGuest"]);
    const b = namedMatch(core, ["BetaHost", "BetaGuest"]);

    // Everyone in A leaves → the room is destroyed.
    a.host.receiveMsg(wire.leave);
    a.guest.receiveMsg(wire.leave);
    expect(server.roomCount()).toBe(1);

    // Room B still plays a complete round.
    await until(() => b.host.lastView()?.phase === "aiming", "room B aiming");
    const b0 = b.host.lastView()!.pawns.find((p) => p.id === "p0")!;
    const b1 = b.guest.lastView()!.pawns.find((p) => p.id === "p1")!;
    b.host.receiveMsg(wire.command({ type: "aim", x: b0.position.x + 300, y: b0.position.y }));
    b.guest.receiveMsg(wire.command({ type: "aim", x: b1.position.x - 300, y: b1.position.y }));
    b.host.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    b.guest.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    b.host.receiveMsg(wire.command({ type: "confirmLaunch" }));
    b.guest.receiveMsg(wire.command({ type: "confirmLaunch" }));
    await until(() => b.host.lastView()?.phase === "moving", "room B resolves after A's death");
    expect(b.host.lastView()!.pawns.filter((p) => p.launch).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Privileged commands
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: privileged commands", () => {
  it("resolveRound over the wire is unauthorized and resolves nothing", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    m.host.receiveMsg(wire.command({ type: "resolveRound" }));
    expect(m.host.errorCodes()).toContain("unauthorized");
    await new Promise((r) => setTimeout(r, 250));
    expect(m.host.lastView()?.phase).toBe("aiming"); // nobody was moved
  });

  it("reset over the wire is unauthorized; as a top-level type it does not exist", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    m.host.receiveMsg(wire.command({ type: "reset" }));
    expect(m.host.errorCodes()).toContain("unauthorized");
    m.host.receiveMsg({ protocolVersion: 1, type: "reset" });
    m.host.receiveMsg({ protocolVersion: 1, type: "resolveRound" });
    expect(m.host.errorCodes().slice(-2)).toEqual([
      "unknown-message-type",
      "unknown-message-type",
    ]);
    expect(m.host.lastView()?.phase).toBe("aiming");
  });

  it("start_match authorization is enforced server-side, not by the UI", async () => {
    const { core } = newCore();
    const host = connect(core);
    host.socket.receiveMsg(wire.create);
    const code = (welcomeOf(host.socket) as { roomId: string }).roomId;
    const guest = connect(core);
    guest.socket.receiveMsg(wire.join(code));

    // The guest fires the host-only action directly on the wire.
    guest.socket.receiveMsg(wire.start);
    expect(guest.socket.errorCodes()).toEqual(["unauthorized"]);
    expect(host.socket.views().length).toBe(0); // no match was started

    // The real host still can.
    host.socket.receiveMsg(wire.start);
    await until(() => host.socket.lastView()?.phase === "aiming", "host starts the match");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Private snapshot data (actual wire messages)
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: wire privacy", () => {
  it("during aiming the opponent's aim and power are structurally absent from every wire message", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    // The host picks a distinctive aim + power.
    m.host.receiveMsg(wire.command({ type: "aim", x: 7777.5, y: 1234.25 }));
    m.host.receiveMsg(wire.command({ type: "setPower", power: 4 }));
    await new Promise((r) => setTimeout(r, 100));

    const ALLOWED_PAWN_KEYS = new Set([
      "id", "name", "position", "velocity", "radius",
      "eliminated", "confirmed", "launch", "isLocal", "colorIndex",
    ]);
    for (const view of m.guest.views()) {
      // The guest's own view carries only THEIR OWN aim/power…
      expect(view.aimDirection).toBeNull();
      expect(view.power).toBe(CONFIG.power.default);
      // …no pawn exposes aim/power fields at all (structural privacy)…
      for (const pawn of view.pawns) {
        expect(Object.keys(pawn).every((k) => ALLOWED_PAWN_KEYS.has(k))).toBe(true);
        expect(pawn.launch).toBeNull();
      }
    }
    // …and the raw aim target never appears on the guest's wire.
    expect(m.guest.sent.join("\n")).not.toContain("7777");
  });

  it("a credential appears only in its holder's own welcome; nowhere else on anyone's wire", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    const everything = [...m.host.sent, ...m.guest.sent];
    for (const credential of m.credentials) {
      const occurrences = everything.filter((s) => s.includes(credential));
      expect(occurrences.length).toBe(1); // exactly the holder's welcome
    }
    const hostWelcome = welcomeOf(m.host) as { reconnectToken: string };
    expect(m.guest.sent.join("\n")).not.toContain(hostWelcome.reconnectToken);
  });

  it("readiness is public by design — the choice behind it never is", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    m.host.receiveMsg(wire.command({ type: "aim", x: 7777.5, y: 1234.25 }));
    m.host.receiveMsg(wire.command({ type: "setPower", power: 4 }));
    m.host.receiveMsg(wire.command({ type: "confirmLaunch" }));
    await new Promise((r) => setTimeout(r, 100));

    const view = m.guest.lastView()!;
    expect(view.pawns.find((p) => p.id === "p0")?.confirmed).toBe(true); // public
    expect(view.pawns.find((p) => p.id === "p0")?.launch).toBeNull(); // private
    expect(view.aimDirection).toBeNull(); // the guest's own, still unset
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Malformed / hostile input
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: malformed input", () => {
  it("malformed wire messages are all rejected and the connection survives", async () => {
    const { core } = newCore();
    const c = connect(core);
    c.socket.receiveMsg(wire.create);
    const code = (welcomeOf(c.socket) as { roomId: string }).roomId;

    const garbage = [
      "not json",
      "[1,2]",
      "null",
      "42",
      '"hello"',
      "{",
      JSON.stringify({ protocolVersion: 2, type: "create_room" }),
      JSON.stringify({ type: "create_room" }), // no protocolVersion
      JSON.stringify({ protocolVersion: 1, type: "command" }), // no command
      JSON.stringify({ protocolVersion: 1, type: "command", command: "aim" }),
      JSON.stringify({ protocolVersion: 1, type: "command", command: [] }),
      JSON.stringify({ protocolVersion: 1, type: "command", command: null }),
      JSON.stringify({ protocolVersion: 1, type: "command", command: {}, extra: 1 }),
      JSON.stringify({ protocolVersion: 1, type: "fire_lasers" }),
    ];
    for (const raw of garbage) c.socket.receive(raw);
    expect(c.socket.errorCodes().length).toBe(garbage.length);

    // The connection is still usable: a valid room action works.
    c.socket.receiveMsg(wire.setName("Still Alive"));
    const roomState = c.socket.lastOf("room_state") as { roster: Array<{ displayName?: string }> };
    expect(roomState.roster.some((s) => s.displayName === "Still Alive")).toBe(true);
    expect(code).toMatch(/^[A-Z0-9]{4}$/); // sanity: the room is fine
  });

  it("hostile command payloads never crash, never corrupt room state", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");
    const initial = m.guest.lastView()!.pawns.map((p) => ({ ...p.position }));

    const hostile: unknown[] = [
      { type: "aim", x: NaN, y: 0 },
      { type: "aim", x: Infinity, y: 0 },
      { type: "aim", x: -Infinity, y: 5 },
      { type: "aim", x: "5", y: 5 },
      { type: "aim", x: null, y: 0 },
      { type: "aim", y: 5 }, // missing x
      { type: "setPower", power: NaN },
      { type: "setPower", power: "3" },
      { type: "setPower" }, // missing power
      { type: "eliminate", playerId: "p1" }, // authoritative outcome forgery
      { type: "setPhase", phase: "finished" },
      { type: "setPosition", playerId: "p1", x: 0, y: 0 },
      { type: "setWinner", winnerId: "p0" },
    ];
    for (const payload of hostile) m.host.receiveMsg(wire.command(payload));
    expect(m.host.errorCodes().length).toBe(hostile.length);

    // Valid commands still work afterwards…
    m.host.receiveMsg(wire.command({ type: "aim", x: CX + 300, y: CY }));
    m.host.receiveMsg(wire.command({ type: "setPower", power: 2 }));
    expect(m.host.lastView()?.aimDirection).not.toBeNull();
    // …and the room state is uncorrupted: phase, positions, no phantom effects.
    const guestView = m.guest.lastView()!;
    expect(guestView.phase).toBe("aiming");
    expect(guestView.pawns.map((p) => ({ ...p.position }))).toEqual(initial);
    expect(guestView.pawns.every((p) => !p.eliminated)).toBe(true);
    expect(guestView.winnerId).toBeNull();
  });

  it("out-of-range and fractional powers are clamped to the legal integer set", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    for (const [power, expected] of [
      [0, 1], [-99, 1], [99, 5], [2.7, 3], [1.5, 2], [-0.01, 1], [5.4, 5],
    ] as const) {
      m.host.receiveMsg(wire.command({ type: "setPower", power }));
      await new Promise((r) => setTimeout(r, 30));
      expect(m.host.lastView()?.power, `power ${power}`).toBe(expected);
    }
  });

  it("extreme-but-finite aim coordinates normalize to a unit direction (no NaN on the wire)", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    m.host.receiveMsg(wire.command({ type: "aim", x: 1e308, y: -1e308 }));
    await new Promise((r) => setTimeout(r, 50));
    const dir = m.host.lastView()!.aimDirection!;
    expect(Number.isFinite(dir.x)).toBe(true);
    expect(Number.isFinite(dir.y)).toBe(true);
    expect(Math.abs(Math.hypot(dir.x, dir.y) - 1)).toBeLessThan(1e-9);

    // Aim at the world origin: still a finite unit vector, no crash.
    m.host.receiveMsg(wire.command({ type: "aim", x: 0, y: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    const dir2 = m.host.lastView()!.aimDirection!;
    expect(Number.isFinite(dir2.x) && Number.isFinite(dir2.y)).toBe(true);
    for (const view of m.guest.views()) {
      for (const pawn of view.pawns) {
        expect(Number.isFinite(pawn.position.x)).toBe(true);
        expect(Number.isFinite(pawn.position.y)).toBe(true);
      }
    }
  });

  it("commands in the wrong phase, after leaving and after the match are all rejected", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    // Both confirm → the round resolves; aiming commands are then refused.
    const p0 = m.host.lastView()!.pawns.find((p) => p.id === "p0")!;
    const p1 = m.guest.lastView()!.pawns.find((p) => p.id === "p1")!;
    m.host.receiveMsg(wire.command({ type: "aim", x: p0.position.x + 300, y: p0.position.y }));
    m.guest.receiveMsg(wire.command({ type: "aim", x: p1.position.x - 300, y: p1.position.y }));
    m.host.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    m.guest.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    m.host.receiveMsg(wire.command({ type: "confirmLaunch" }));
    m.guest.receiveMsg(wire.command({ type: "confirmLaunch" }));
    await until(() => m.host.lastView()?.phase === "moving", "round resolves");

    m.host.receiveMsg(wire.command({ type: "aim", x: 0, y: 0 }));
    expect(m.host.errorCodes()).toContain("wrong-phase");

    // After leaving, no command is accepted at all.
    m.host.receiveMsg(wire.leave);
    m.host.receiveMsg(wire.command({ type: "aim", x: 0, y: 0 }));
    expect(m.host.errorCodes()).toContain("not-in-room");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reconnect security
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: reconnect security", () => {
  it("credentials are 43-char base64url (256-bit) and all distinct", () => {
    const { core } = newCore();
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = connect(core);
      c.socket.receiveMsg(wire.create);
      tokens.push((welcomeOf(c.socket) as { reconnectToken: string }).reconnectToken);
    }
    expect(new Set(tokens).size).toBe(6);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("garbage and foreign credentials are rejected uniformly and steal nothing", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    // A fresh connection presents garbage, the room code, and a
    // well-formed but never-issued value: all must fail identically.
    for (const token of ["garbage", m.code, "x".repeat(43)]) {
      const fresh = connect(core);
      fresh.socket.receiveMsg(wire.reconnect(token));
      expect(fresh.socket.errorCodes(), `token ${token.slice(0, 8)}`).toEqual([
        "invalid-reconnect",
      ]);
      fresh.handle.close();
    }

    // The legitimate players are untouched and still in control.
    m.host.receiveMsg(wire.command({ type: "aim", x: CX + 300, y: CY }));
    expect(m.host.lastView()?.aimDirection).not.toBeNull();
    expect(m.guest.errorCodes()).toEqual([]);
  });

  it("an expired reservation is dead: the credential cannot be reused and the seat is freed for joiners", async () => {
    const { core } = newCore({ reconnectReservationMs: 80 });
    const host = connect(core);
    host.socket.receiveMsg(wire.create);
    const code = (welcomeOf(host.socket) as { roomId: string }).roomId;
    const guest = connect(core);
    guest.socket.receiveMsg(wire.join(code));
    const guestToken = (welcomeOf(guest.socket) as { reconnectToken: string }).reconnectToken;

    // The guest's connection dies: the seat is reserved — NOT stealable.
    // A joiner arrives while the window is open and must take a LATER
    // seat, never the reserved p1.
    guest.socket.close();
    await new Promise((r) => setTimeout(r, 30));
    const joinerEarly = connect(core);
    joinerEarly.socket.receiveMsg(wire.join(code));
    const earlyWelcome = welcomeOf(joinerEarly.socket) as { playerId: string };
    expect(earlyWelcome.playerId).toBe("p2"); // the reserved seat was skipped

    // …the window expires…
    await new Promise((r) => setTimeout(r, 300));

    // …the credential is dead…
    const reconnector = connect(core);
    reconnector.socket.receiveMsg(wire.reconnect(guestToken));
    expect(reconnector.socket.errorCodes()).toEqual(["invalid-reconnect"]);

    // …and the expired seat is genuinely free: the next joiner takes p1.
    const joiner = connect(core);
    joiner.socket.receiveMsg(wire.join(code));
    const w = welcomeOf(joiner.socket) as { playerId: string };
    expect(w.playerId).toBe("p1");
  });

  it("reconnect after the match finished recovers the seat without restarting anything", async () => {
    const { core } = newCore();
    const m = namedMatch(core, ["Host", "Guest"]);
    await until(() => m.host.lastView()?.phase === "aiming", "match reaches aiming");

    // The host launches itself off the floor; the guest, aiming safely
    // inward (there is no wall to catch an outward launch), wins.
    const p0 = m.host.lastView()!.pawns.find((p) => p.id === "p0")!;
    const out = outwardFrom(p0.position);
    m.host.receiveMsg(wire.command({ type: "aim", x: out.x, y: out.y }));
    m.host.receiveMsg(wire.command({ type: "setPower", power: 5 }));
    const p1 = m.guest.lastView()!.pawns.find((p) => p.id === "p1")!;
    m.guest.receiveMsg(wire.command({ type: "aim", x: p1.position.x, y: p1.position.y - 100 }));
    m.guest.receiveMsg(wire.command({ type: "setPower", power: 1 }));
    m.host.receiveMsg(wire.command({ type: "confirmLaunch" }));
    m.guest.receiveMsg(wire.command({ type: "confirmLaunch" }));
    await until(() => m.guest.lastView()?.phase === "finished", "match finishes", 9000);
    expect(m.guest.lastView()!.winnerId).toBe("p1");

    // Commands are dead in the finished phase…
    m.guest.receiveMsg(wire.command({ type: "aim", x: 0, y: 0 }));
    expect(m.guest.errorCodes()).toContain("wrong-phase");

    // …the winner drops and recovers with the credential: same seat, the
    // match is NOT restarted, exactly one current-state push.
    m.guest.close();
    const fresh = connect(core);
    fresh.socket.receiveMsg(wire.reconnect(m.credentials[1]));
    const w = welcomeOf(fresh.socket) as { playerId: string; roomState: string };
    expect(w.playerId).toBe("p1");
    expect(w.roomState).toBe("finished");
    await new Promise((r) => setTimeout(r, 250));
    const views = fresh.socket.views();
    expect(views.length).toBe(1); // no historical replay
    expect(views[0].phase).toBe("finished");
    expect(views[0].winnerId).toBe("p1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// WebSocket lifecycle edges
// ─────────────────────────────────────────────────────────────────────────

describe("adversarial: lifecycle edges", () => {
  it("joining a destroyed room fails safely; double leave and double disconnect are idempotent", () => {
    const { server, core } = newCore();
    const c = connect(core);
    c.socket.receiveMsg(wire.create);
    const code = (welcomeOf(c.socket) as { roomId: string }).roomId;

    c.socket.receiveMsg(wire.leave); // room empties → destroyed
    expect(server.roomCount()).toBe(0);

    const stranger = connect(core);
    stranger.socket.receiveMsg(wire.join(code));
    expect(stranger.socket.errorCodes()).toEqual(["unknown-room"]);

    // Leaving twice is a clean error, never a crash.
    stranger.socket.receiveMsg(wire.leave);
    expect(stranger.socket.errorCodes()).toEqual(["unknown-room", "not-in-room"]);

    // Double (force) disconnect is idempotent and harmless.
    expect(() => {
      stranger.handle.close();
      stranger.handle.close();
      c.handle.close();
    }).not.toThrow();
    expect(server.sessionCount()).toBe(0);
  });
});
