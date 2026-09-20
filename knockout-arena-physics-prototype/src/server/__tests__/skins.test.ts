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
 * Disc skins — the cosmetic palette index of a player's pawn.
 *
 * THE DEFAULT IS RANDOM: a seat is dealt its skin at seating time,
 * drawn from the palette while EXCLUDING whatever the already-seated
 * players wear — so the skin is only known after joining a room (or a
 * public game). An explicit set_skin overrides the deal; `null` hands
 * the decision back to the server (a fresh draw). The rest is the same
 * lifecycle a display name has:
 *
 *   - validation: an integer in [0, palette length) or null; anything
 *     else is a clean "invalid-skin" (the wire carries shape only);
 *   - identity: the skin always lands on the CALLER's own seat (the
 *     session is derived; the wire has no playerId to forge);
 *   - authority: changes only while the room waits (room-playing once
 *     the roster froze), and the roster broadcast carries the skin;
 *   - the wire: `skin` rides on EVERY roster seat (there is no single
 *     default to omit anymore);
 *   - matches: the dealt/chosen skin becomes the pawn's colorIndex
 *     (frozen at startMatch);
 *   - a freed lobby seat is unassigned again (no inheritance).
 *
 * Determinism: `randomSkinIndex: () => 0` always picks the FIRST still-
 * available palette index, so seats are dealt 0, 1, 2, … in join order.
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
  const server = createGameServer({ randomSkinIndex: () => 0 });
  liveServers.push(server);
  return server;
}

/** A server with the production (uniform-random) draw. */
function randomServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}

/** Unwrap a successful facade result or fail loudly. */
function must<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

/** The room's seat skins, plain numbers in seat order. */
function seatSkins(server: GameServer, roomCode: string): number[] {
  const room = server.getRoom(roomCode);
  if (!room) throw new Error(`room ${roomCode} gone`);
  return room.seats.map((s) => s.skin);
}

/** A seated host (p0) in a fresh room. */
function seatedHost() {
  const server = newServer();
  const host = server.connect();
  const created = must(server.createRoom(host));
  return { server, host, room: created.room };
}

describe("the random default skin", () => {
  it("deals every seat a skin AT SEATING (the creator included)", () => {
    const { server, host, room } = seatedHost();
    void host;
    expect(seatSkins(server, room.code)).toEqual([0]); // first pick
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    expect(seatSkins(server, room.code)).toEqual([0, 1]); // first available
  });

  it("the draw EXCLUDES the colors the seated players wear (real randomness)", () => {
    // For every explicitly-taken color, a joiner without a choice must
    // never be dealt it. A draw ignoring the exclusion would fail this
    // with overwhelming probability, so the pin is meaningful even with
    // the production RNG.
    for (let taken = 0; taken < PLAYER_COLORS.length; taken++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const server = randomServer();
        const host = server.connect();
        const created = must(server.createRoom(host));
        must(server.setSkin(host, taken));
        const guest = server.connect();
        const joined = must(server.joinRoom(guest, created.room.code));
        const dealt = joined.room.seats[1].skin;
        expect(dealt).not.toBe(taken);
        expect(dealt).toBeGreaterThanOrEqual(0);
        expect(dealt).toBeLessThan(PLAYER_COLORS.length);
      }
    }
  });

  it("six players hold six DISTINCT skins (deterministic draw)", () => {
    const { server, room } = seatedHost();
    for (let i = 1; i < PLAYER_COLORS.length; i++) {
      must(server.joinRoom(server.connect(), room.code));
    }
    const skins = seatSkins(server, room.code);
    expect(new Set(skins).size).toBe(PLAYER_COLORS.length);
    expect([...skins].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("setSkin(null) hands the decision back: a fresh draw excluding others", () => {
    const { server, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code)); // p1 dealt 1

    // The guest makes an explicit pick, then returns to random. The
    // pool excludes p0's 0; the deterministic draw takes its first
    // element → 1 again (proving a re-deal happened, not a keep).
    must(server.setSkin(guest, 5));
    expect(seatSkins(server, room.code)).toEqual([0, 5]);
    must(server.setSkin(guest, null));
    expect(seatSkins(server, room.code)).toEqual([0, 1]);
  });

  it("a freed lobby seat is unassigned: the next occupant gets a FRESH draw", () => {
    const { server, host, room } = seatedHost();
    must(server.setSkin(host, 4)); // explicit, would leak if inherited
    const guest = server.connect();
    must(server.joinRoom(guest, room.code)); // keeps the room alive

    must(server.leaveRoom(host)); // p0 is freed
    const next = server.connect();
    must(server.joinRoom(next, room.code)); // takes the freed seat p0
    // The guest had been dealt 0 (the first pick ≠ the host's 4); the
    // newcomer's pool excludes that 0 → deterministic first pick is 1 —
    // NOT the previous occupant's 4 (no inheritance).
    expect(seatSkins(server, room.code)).toEqual([1, 0]);
  });
});

describe("skin validation", () => {
  it("accepts every palette index (0..length-1)", () => {
    const { server, host } = seatedHost();
    for (let skin = 0; skin < PLAYER_COLORS.length; skin++) {
      const result = must(server.setSkin(host, skin));
      expect(result.room.seats[0].skin).toBe(skin);
    }
  });

  it("accepts null as the request for a fresh random skin", () => {
    const { server, host, room } = seatedHost();
    const result = must(server.setSkin(host, null));
    expect(result.room.seats[0].skin).toBe(0); // re-dealt (deterministic)
    expect(seatSkins(server, room.code)).toEqual([0]);
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

  it("freezes skins once the match starts (room-playing), null included", () => {
    const { server, host, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.setSkin(host, 3));
    must(server.startMatch(room.id));

    expect(server.setSkin(host, 5)).toEqual({
      ok: false,
      reason: "room-playing",
    });
    expect(server.setSkin(host, null)).toEqual({
      ok: false,
      reason: "room-playing",
    });
    // The frozen roster keeps the pre-start skin.
    expect(server.getRoom(room.code)!.seats[0].skin).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Matches: the dealt/chosen skin becomes the pawn's colorIndex
// ────────────────────────────────────────────────────────────────────────

describe("skins in matches", () => {
  it("pawns freeze with the seat skins: dealt default + chosen green", async () => {
    const { server, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.setSkin(guest, 3)); // green; the host keeps its dealt 0

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
    expect(byId.get("p0")).toBe(0); // the deterministic deal
    expect(byId.get("p1")).toBe(3); // the guest's chosen green
  });
});

// ────────────────────────────────────────────────────────────────────────
// The seat lifecycle: skins die with a freed lobby seat
// ────────────────────────────────────────────────────────────────────────

describe("skins across the seat lifecycle", () => {
  it("the skin survives on the seat while the room waits (it is seat-scoped)", () => {
    const { server, host, room } = seatedHost();
    must(server.setSkin(host, 2));
    // Roster pushes and other cosmetic traffic never reset it.
    expect(server.getSeat(host)!.room.seats[0].skin).toBe(2);
    expect(server.getRoom(room.code)!.seats[0].skin).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The wire: every seat carries its (dealt or chosen) skin
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
  it("every roster seat carries its skin; the deal is broadcast to all", () => {
    const { core } = newCore();
    const creator = connect(core);
    creator.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const code = (creator.lastOf("welcome") as { roomId: string }).roomId;

    // The creator's dealt skin rides on the very first roster.
    const plain = creator.lastOf("room_state") as {
      roster: Array<Record<string, unknown>>;
    };
    expect(plain.roster[0]).toEqual({
      playerId: "p0",
      connected: true,
      skin: 0,
    });

    const joiner = connect(core);
    joiner.receiveMsg({ protocolVersion: 1, type: "join_room", roomId: code });

    // The joiner was dealt skin 1 (first not held by p0) and EVERY
    // member's latest room_state says so.
    for (const socket of [creator, joiner]) {
      const state = socket.lastOf("room_state") as {
        roster: Array<Record<string, unknown>>;
      };
      expect(state.roster[0]).toEqual({ playerId: "p0", connected: true, skin: 0 });
      expect(state.roster[1]).toEqual({ playerId: "p1", connected: true, skin: 1 });
    }

    // An explicit pick rides through and is seen by everyone.
    joiner.receiveMsg(setSkin(3));
    for (const socket of [creator, joiner]) {
      const state = socket.lastOf("room_state") as {
        roster: Array<Record<string, unknown>>;
      };
      expect(state.roster[1]).toEqual({ playerId: "p1", connected: true, skin: 3 });
    }
  });

  it("skin:null re-deals over the wire (clean ok, new roster)", () => {
    const { core } = newCore();
    const host = connect(core);
    host.receiveMsg({ protocolVersion: 1, type: "create_room" });
    host.receiveMsg(setSkin(4));
    host.receiveMsg(setSkin(null));
    const state = host.lastOf("room_state") as {
      roster: Array<Record<string, unknown>>;
    };
    // Re-dealt deterministically (first available pick → 0).
    expect(state.roster[0]).toEqual({ playerId: "p0", connected: true, skin: 0 });
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

// DEFAULT_SKIN stays exported as the clients' fallback.
describe("the fallback constant", () => {
  it("DEFAULT_SKIN is still the palette's orange", () => {
    expect(DEFAULT_SKIN).toBe(0);
    expect(PLAYER_COLORS[DEFAULT_SKIN]).toBe("#ff8a3d");
  });
});
