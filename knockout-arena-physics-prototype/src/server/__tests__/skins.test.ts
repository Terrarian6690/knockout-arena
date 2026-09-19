import { afterEach, describe, expect, it } from "vitest";
import { PLAYER_COLORS } from "../../game";
import {
  createGameServer,
  createTransportCore,
  type GameServer,
  type TransportCore,
  type TransportSocket,
} from "../index";
import { DEFAULT_SKIN } from "../roomManager";

/**
 * Disc skins — the cosmetic palette index of a player's pawn
 * (set_skin), the exact same lifecycle a display name has:
 *
 *   - validation: an integer in [0, palette length); anything else is
 *     a clean "invalid-skin" (the wire carries shape only);
 *   - identity: the skin always lands on the CALLER's own seat (the
 *     session is derived; the wire has no playerId to forge);
 *   - authority: changes only while the room waits (room-playing once
 *     the roster froze), and the roster broadcast carries the skin;
 *   - the wire stays additive: `skin` appears on a roster seat ONLY
 *     when it differs from the default (orange), so older payloads
 *     stay byte-identical while everyone is default;
 *   - matches: the chosen skin becomes the pawn's colorIndex (frozen
 *     at startMatch) — the arena disc and every in-match list show it;
 *   - a freed lobby seat falls back to the default (no inheritance).
 */

const liveServers: GameServer[] = [];
const liveCores: TransportCore[] = [];

afterEach(() => {
  for (const core of liveCores) core.close();
  liveCores.length = 0;
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function newServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}

/** Unwrap a successful facade result or fail loudly. */
function must<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

/** A seated host (p0) in a fresh room. */
function seatedHost() {
  const server = newServer();
  const host = server.connect();
  const created = must(server.createRoom(host));
  return { server, host, room: created.room };
}

describe("skin validation", () => {
  it("accepts every palette index (0..length-1)", () => {
    const { server, host } = seatedHost();
    for (let skin = 0; skin < PLAYER_COLORS.length; skin++) {
      const result = must(server.setSkin(host, skin));
      expect(result.room.seats[0].skin).toBe(skin);
    }
  });

  it("rejects non-integers and out-of-range indices with invalid-skin", () => {
    const { server, host } = seatedHost();
    for (const bad of [-1, PLAYER_COLORS.length, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(server.setSkin(host, bad)).toEqual({
        ok: false,
        reason: "invalid-skin",
      });
    }
  });

  it("refuses a session without a seat (not-in-room)", () => {
    const server = newServer();
    const lone = server.connect();
    expect(server.setSkin(lone, 3)).toEqual({ ok: false, reason: "not-in-room" });
  });

  it("freezes skins once the match starts (room-playing)", () => {
    const { server, host, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.setSkin(host, 3));
    must(server.startMatch(room.id));

    expect(server.setSkin(host, 5)).toEqual({
      ok: false,
      reason: "room-playing",
    });
    // The frozen roster keeps the pre-start skin.
    expect(server.getRoom(room.code)!.seats[0].skin).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Matches: the skin becomes the pawn's colorIndex
// ────────────────────────────────────────────────────────────────────────

describe("skins in matches", () => {
  it("the chosen skin is the pawn's palette index; defaults stay orange", async () => {
    const { server, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.setSkin(guest, 3)); // green; the host keeps the default

    const received: string[] = [];
    server.onRoomState(guest, (serialized) => received.push(serialized));
    must(server.startMatch(room.id));

    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(received[0]) as {
      pawns: Array<{ id: string; colorIndex: number }>;
    };
    const byId = new Map(snapshot.pawns.map((p) => [p.id, p.colorIndex]));
    expect(byId.get("p0")).toBe(DEFAULT_SKIN); // orange by default
    expect(byId.get("p1")).toBe(3); // the guest's chosen green
  });
});

// ────────────────────────────────────────────────────────────────────────
// The seat lifecycle: skins die with a freed lobby seat
// ────────────────────────────────────────────────────────────────────────

describe("skins across the seat lifecycle", () => {
  it("a freed lobby seat falls back to the default (no inheritance)", () => {
    const { server, host, room } = seatedHost();
    must(server.setSkin(host, 4));
    expect(server.getRoom(room.code)!.seats[0].skin).toBe(4);

    // A guest keeps the room alive while the host leaves it.
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.leaveRoom(host)); // p0 is freed
    const next = server.connect();
    must(server.joinRoom(next, room.code)); // takes the freed seat p0
    expect(server.getRoom(room.code)!.seats[0].skin).toBe(DEFAULT_SKIN);
  });

  it("the skin survives on the seat while the room waits (it is seat-scoped)", () => {
    const { server, host, room } = seatedHost();
    must(server.setSkin(host, 2));
    // Roster pushes and other cosmetic traffic never reset it.
    expect(server.getSeat(host)!.room.seats[0].skin).toBe(2);
    expect(server.getRoom(room.code)!.seats[0].skin).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The wire: additive skin, strict envelope, real broadcast
// ────────────────────────────────────────────────────────────────────────

// The wire: set_skin over the real transport core
// ────────────────────────────────────────────────────────────────────────

/** Minimal fake socket (the transport's contract, test-driven). */
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
  receiveMsg(message: unknown): void {
    for (const cb of [...this.messageHandlers]) cb(JSON.stringify(message));
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .filter((m) => m.type === type);
  }
  lastOf(type: string): Record<string, unknown> | undefined {
    const all = this.ofType(type);
    return all[all.length - 1];
  }
}

function newCore() {
  const server = newServer();
  const core = createTransportCore(server);
  liveCores.push(core);
  return { server, core };
}

function connect(core: TransportCore): FakeSocket {
  const socket = new FakeSocket();
  core.attach(socket);
  return socket;
}

const setSkin = (skin: unknown) => ({ protocolVersion: 1, type: "set_skin", skin });

describe("set_skin over the wire", () => {
  it("broadcasts the new roster to every member; skin is additive", () => {
    const { core } = newCore();
    const creator = connect(core);
    creator.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const code = (creator.lastOf("welcome") as { roomId: string }).roomId;

    // Before any skin: roster seats carry NO skin key at all — older
    // payloads stay byte-identical while everyone is the default orange.
    const plain = creator.lastOf("room_state") as {
      roster: Array<Record<string, unknown>>;
    };
    expect(plain.roster[0]).toEqual({ playerId: "p0", connected: true });
    expect("skin" in plain.roster[0]).toBe(false);

    const joiner = connect(core);
    joiner.receiveMsg({ protocolVersion: 1, type: "join_room", roomId: code });
    joiner.receiveMsg(setSkin(3));

    // EVERY member's latest room_state shows the skin — on p1 only.
    for (const socket of [creator, joiner]) {
      const state = socket.lastOf("room_state") as {
        roster: Array<Record<string, unknown>>;
      };
      expect(state.roster[0]).toEqual({ playerId: "p0", connected: true });
      expect(state.roster[1]).toEqual({
        playerId: "p1",
        connected: true,
        skin: 3,
      });
    }
  });

  it("rejects a forged playerId with a strict-envelope violation", () => {
    const { core } = newCore();
    const host = connect(core);
    host.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const before = host.sent.length;

    host.receiveMsg({ ...setSkin(2), playerId: "p3" });
    expect(host.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    // Nothing was applied.
    expect(host.sent.length).toBe(before + 1); // just the error frame
  });

  it("invalid payloads are clean invalid-skin errors, connection intact", () => {
    const { core } = newCore();
    const host = connect(core);
    host.receiveMsg({ protocolVersion: 1, type: "create_room" });

    host.receiveMsg({ ...setSkin(99) });
    expect(host.lastOf("error")).toMatchObject({ code: "invalid-skin" });
    host.receiveMsg({ ...setSkin("violet") });
    expect(host.lastOf("error")).toMatchObject({ code: "malformed-payload" });

    // The connection lives on: a valid pick still works.
    host.receiveMsg(setSkin(1));
    const state = host.lastOf("room_state") as {
      roster: Array<Record<string, unknown>>;
    };
    expect(state.roster[0]).toEqual({
      playerId: "p0",
      connected: true,
      skin: 1,
    });
  });
});
