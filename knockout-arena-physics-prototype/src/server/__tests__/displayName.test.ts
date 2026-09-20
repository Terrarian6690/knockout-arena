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
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
} from "../displayName";

/**
 * Player display names — the cosmetic, seat-scoped label (set_name).
 *
 * What these tests pin:
 *   - validation: 1..16 Unicode CODE POINTS after trimming, no control
 *     characters, any other Unicode allowed; empty-after-trim rejected;
 *   - identity: the name always lands on the CALLER's own seat (derived
 *     from the session — the wire message has no playerId at all, and a
 *     forged one is a strict-envelope violation);
 *   - authority: the server validates for real (invalid-name), only
 *     allows changes while the room waits (room-playing once frozen),
 *     and broadcasts the new roster through the normal room_state path;
 *   - the wire stays additive: `displayName` appears on a roster seat
 *     ONLY when set (older payloads stay byte-identical);
 *   - matches: chosen names become the engine's pawn names (frozen at
 *     startMatch); unnamed players keep the "Player N" fallback;
 *   - reconnect: the name lives on the SEAT, survives drop/reconnect
 *     with the same identity, is never part of the credential, and dies
 *     with a freed lobby seat (no inheritance by the next occupant);
 *   - nothing sensitive (credentials, session tokens) ever rides along.
 *
 * Most tests use the GameServer facade like the transport does; the wire
 * section drives the real createTransportCore over fake sockets.
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

/** A seated host (p0) in a fresh room; `name` is optionally set. */
function seatedHost(name?: string) {
  const server = newServer();
  const host = server.connect();
  const created = must(server.createRoom(host));
  if (name !== undefined) {
    must(server.setName(host, name));
  }
  return { server, host, room: created.room };
}

// ────────────────────────────────────────────────────────────────────────
// Validation (the shared rules; the client mirrors them for UX only)
// ────────────────────────────────────────────────────────────────────────

describe("display-name validation", () => {
  it("accepts short and exactly-16-code-point names", () => {
    expect(normalizeDisplayName("Szymon")).toBe("Szymon");
    expect(normalizeDisplayName("A")).toBe("A");
    expect(normalizeDisplayName("a".repeat(MAX_DISPLAY_NAME_LENGTH))).toBe(
      "a".repeat(MAX_DISPLAY_NAME_LENGTH)
    );
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    // 16 emoji = 32 UTF-16 units but 16 code points: valid.
    expect(normalizeDisplayName("😀".repeat(16))).toBe("😀".repeat(16));
    // 17 emoji: one too many.
    expect(normalizeDisplayName("😀".repeat(17))).toBeNull();
    expect(normalizeDisplayName("a".repeat(17))).toBeNull();
  });

  it("trims leading/trailing whitespace (including Unicode)", () => {
    expect(normalizeDisplayName("  Alex  ")).toBe("Alex");
    expect(normalizeDisplayName("\t\n Szymon \r\n")).toBe("Szymon");
    expect(normalizeDisplayName("\u00A0Zosia\u00A0")).toBe("Zosia"); // NBSP
  });

  it("rejects names that are empty after trimming", () => {
    expect(normalizeDisplayName("")).toBeNull();
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("\t\n")).toBeNull();
  });

  it("rejects control characters anywhere in the name", () => {
    for (const bad of [
      "A\nB",
      "A\rB",
      "A\tB",
      "A\u0000B",
      "A\u0007B",
      "A\u007FB", // DEL
      "A\u009BB", // C1
    ]) {
      expect(normalizeDisplayName(bad)).toBeNull();
    }
  });

  it("allows normal Unicode letters, numbers and punctuation", () => {
    for (const good of ["Żółć", "山田太郎", "Szymon_2", "Alex-Spychalski", "Zoë", "ok 🙂"]) {
      expect(normalizeDisplayName(good)).toBe(good);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// The facade: identity, validation, lifecycle
// ────────────────────────────────────────────────────────────────────────

describe("setName at the facade", () => {
  it("sets the caller's OWN name and exposes it in the authoritative roster", () => {
    const { server, host, room } = seatedHost();
    const result = must(server.setName(host, "  Szymon  "));
    expect(result.room.seats[0]).toEqual({
      playerId: "p0",
      connected: true,
      displayName: "Szymon", // trimmed server-side
    });
    // getRoom agrees (by code and by internal id — the dual lookup).
    expect(server.getRoom(room.code)!.seats[0].displayName).toBe("Szymon");
  });

  it("derives the seat from the session: a caller can only name themselves", () => {
    const { server, host, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));

    must(server.setName(guest, "Alex"));
    must(server.setName(host, "Szymon"));

    // Each name landed on its OWN seat — there is no API path (and no
    // wire field, see below) that could name another player.
    const seats = server.getRoom(room.code)!.seats;
    expect(seats[0].displayName).toBe("Szymon");
    expect(seats[1].displayName).toBe("Alex");
  });

  it("names are not unique: two players may share one", () => {
    const { server, room } = seatedHost("Szymon");
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.setName(guest, "Szymon"));
    const seats = server.getRoom(room.code)!.seats;
    expect(seats[0].displayName).toBe("Szymon");
    expect(seats[1].displayName).toBe("Szymon");
  });

  it("rejects invalid names with a clean invalid-name", () => {
    const { server, host, room } = seatedHost();
    for (const bad of ["", "   ", "a".repeat(17), "A\nB", "A\tB", "A\u0000B"]) {
      expect(server.setName(host, bad)).toEqual({ ok: false, reason: "invalid-name" });
    }
    // Non-string input (hostile callers) is equally invalid.
    expect(server.setName(host, 42)).toEqual({ ok: false, reason: "invalid-name" });
    // Nothing stuck: the roster still has no name.
    expect(server.getRoom(room.code)!.seats[0].displayName).toBeNull();
  });

  it("rejects sessions that hold no seat (not-in-room)", () => {
    const server = newServer();
    const stranger = server.connect(); // connected, never seated
    expect(server.setName(stranger, "Nobody")).toEqual({
      ok: false,
      reason: "not-in-room",
    });
  });

  it("freezes names once the match starts (room-playing)", () => {
    const { server, host, room } = seatedHost("Szymon");
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.startMatch(room.id));

    expect(server.setName(host, "Renamed")).toEqual({
      ok: false,
      reason: "room-playing",
    });
    // The frozen roster keeps the pre-start name.
    expect(server.getRoom(room.code)!.seats[0].displayName).toBe("Szymon");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Matches: names become the engine's pawn names
// ────────────────────────────────────────────────────────────────────────

describe("display names in matches", () => {
  it("chosen names become pawn names; unnamed players keep the fallback", async () => {
    const { server, room } = seatedHost("Szymon");
    const guest = server.connect();
    must(server.joinRoom(guest, room.code)); // stays unnamed

    const received: string[] = [];
    server.onRoomState(guest, (serialized) => received.push(serialized));
    must(server.startMatch(room.id));

    // The first snapshot's pawn names come from the roster the match was
    // started with (frozen at startMatch).
    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(received[0]) as {
      pawns: Array<{ id: string; name: string }>;
    };
    const byId = new Map(snapshot.pawns.map((p) => [p.id, p.name]));
    expect(byId.get("p0")).toBe("Szymon");
    expect(byId.get("p1")).toBe("Player 2"); // the seat-derived fallback
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reconnect: the name lives on the seat, never in the credential
// ────────────────────────────────────────────────────────────────────────

describe("display names across reconnect", () => {
  it("survives drop/reconnect: same identity, same seat, same name", () => {
    const { server, room } = seatedHost();
    const guest = server.connect();
    const joined = must(server.joinRoom(guest, room.code));
    must(server.setName(guest, "Alex"));

    // The credential is opaque and unrelated to the name.
    expect(joined.reconnectToken).toBeTruthy();
    expect(joined.reconnectToken).not.toBe("Alex");
    expect(joined.reconnectToken).not.toContain("Alex");

    // Drop → reserve → recover with the credential.
    expect(server.reserve(guest).ok).toBe(true);
    const recovered = must(server.reconnect(joined.reconnectToken));
    expect(recovered.playerId).toBe("p1"); // same seat
    expect(recovered.room.id).toBe(room.id); // same room
    expect(recovered.room.seats[1].displayName).toBe("Alex"); // same name
  });

  it("a freed lobby seat does not inherit its name", () => {
    const { server, room } = seatedHost();
    const guest = server.connect();
    must(server.joinRoom(guest, room.code));
    must(server.setName(guest, "Alex"));

    // The guest leaves the WAITING room: the seat is freed and joinable
    // (freed lobby seats drop out of the roster entirely).
    expect(server.leaveRoom(guest).ok).toBe(true);
    expect(server.getRoom(room.code)!.seats).toHaveLength(1);

    // The next occupant of that seat starts unnamed.
    const next = server.connect();
    must(server.joinRoom(next, room.code));
    expect(server.getRoom(room.code)!.seats[1].displayName).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// The wire: set_name over the real transport core
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
  json(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.json().filter((m) => m.type === type);
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

function connect(core: TransportCore): { socket: FakeSocket; handle: ConnectionHandle } {
  const socket = new FakeSocket();
  const handle = core.attach(socket);
  return { socket, handle };
}

function setName(name: unknown) {
  return { protocolVersion: 1, type: "set_name", name };
}

describe("set_name over the wire", () => {
  it("broadcasts the new roster to every member; displayName is additive", () => {
    const { core } = newCore();
    const creator = connect(core);
    creator.socket.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const code = (creator.socket.lastOf("welcome") as { roomId: string }).roomId;

    // Before any name: roster seats carry NO displayName key at all
    // (older payloads stay byte-identical).
    const plain = creator.socket.lastOf("room_state") as {
      roster: Array<Record<string, unknown>>;
    };
    expect(plain.roster[0]).toEqual({ playerId: "p0", connected: true });
    expect("displayName" in plain.roster[0]).toBe(false);

    const joiner = connect(core);
    joiner.socket.receiveMsg({ protocolVersion: 1, type: "join_room", roomId: code });

    // The joiner names themselves…
    joiner.socket.receiveMsg(setName("  Żółć  "));

    // …and EVERY member's latest room_state shows it, trimmed, on p1 only.
    for (const socket of [creator.socket, joiner.socket]) {
      const state = socket.lastOf("room_state") as {
        roster: Array<Record<string, unknown>>;
      };
      expect(state.roster).toEqual([
        { playerId: "p0", connected: true },
        { playerId: "p1", connected: true, displayName: "Żółć" },
      ]);
    }

    // The roster broadcast carries no credential material.
    for (const raw of [...creator.socket.sent, ...joiner.socket.sent]) {
      const welcome = JSON.parse(raw) as Record<string, unknown>;
      if (welcome.type === "room_state") {
        expect(welcome.reconnectToken).toBeUndefined();
      }
    }
  });

  it("derives identity from the session: a forged playerId is a malformed envelope", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg({ protocolVersion: 1, type: "create_room" });

    // There is no playerId field on set_name; trying to add one (or any
    // extra field) is rejected by the strict envelope before any
    // semantic handling — a client can never name another player.
    socket.receiveMsg({
      protocolVersion: 1,
      type: "set_name",
      name: "Impostor",
      playerId: "p1",
    });
    const error = socket.lastOf("error") as { code: string };
    expect(error.code).toBe("malformed-payload");

    // And the semantic rejects are clean errors, connection stays usable.
    socket.receiveMsg(setName("A".repeat(17)));
    expect(socket.lastOf("error")).toMatchObject({ code: "invalid-name" });
    socket.receiveMsg(setName("A\nB"));
    expect(socket.lastOf("error")).toMatchObject({ code: "invalid-name" });

    // A valid name still works afterwards on the same connection.
    socket.receiveMsg(setName("Szymon"));
    const state = socket.lastOf("room_state") as {
      roster: Array<Record<string, unknown>>;
    };
    expect(state.roster[0]).toEqual({
      playerId: "p0",
      connected: true,
      displayName: "Szymon",
    });
  });

  it("shape errors (missing/non-string name) are malformed-payload", () => {
    const { core } = newCore();
    const { socket } = connect(core);
    socket.receiveMsg({ protocolVersion: 1, type: "create_room" });
    const before = socket.sent.length;

    socket.receiveMsg({ protocolVersion: 1, type: "set_name" }); // missing
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg(setName(42)); // wrong type
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });
    socket.receiveMsg(setName(null)); // wrong type
    expect(socket.lastOf("error")).toMatchObject({ code: "malformed-payload" });

    // None of those produced a roster broadcast.
    expect(socket.sent.length).toBe(before + 3); // just the three errors
  });
});
