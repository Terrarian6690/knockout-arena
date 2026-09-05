import { afterEach, describe, expect, it } from "vitest";
import { createGameServer, type GameServer } from "../index";
import { createRoomManager, type RoomManager } from "../roomManager";
import {
  generateUniqueRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "../roomCode";

/**
 * Short room codes — the player-facing locator for a room.
 *
 * What these tests pin:
 *   - generation: every room gets a well-formed 4-character code from the
 *     unambiguous alphabet (no I, O, 0, 1), unique among ACTIVE rooms,
 *     with collisions retried (deterministically, via the injectable
 *     factory) and a hard failure if the space were ever exhausted;
 *   - joining: by exact code, by any whitespace/case variant ("k7 p4" →
 *     "K7P4"), by the internal UUID (server-internal compat) — while
 *     malformed and unknown codes are indistinguishably unknown-room;
 *   - lifecycle: the code is stable for the room's lifetime and released
 *     for reuse once the room is destroyed;
 *   - reconnect: UNCHANGED — the credential (not the code) recovers the
 *     seat; a code is not a credential and cannot reconnect or steal one.
 *
 * Most tests drive the GameServer facade exactly like the transport does;
 * the deterministic collision/reuse tests drive the room manager directly
 * (that is where the injectable factory lives).
 */

const liveServers: GameServer[] = [];
const liveManagers: RoomManager[] = [];

function newServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}

afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
  for (const manager of liveManagers) manager.destroy();
  liveManagers.length = 0;
});

/** A factory that replays a fixed candidate sequence (deterministic tests). */
function scriptedFactory(...candidates: string[]): () => string {
  let index = 0;
  return () => {
    if (index >= candidates.length) {
      throw new Error(`scriptedFactory exhausted (used ${candidates.join(", ")})`);
    }
    return candidates[index++];
  };
}

/** Unwrap a successful seat result or fail with the rejection reason. */
function mustSeat<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`expected ok, got: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

// ────────────────────────────────────────────────────────────────────────
// Helpers (the module under test, unit level)
// ────────────────────────────────────────────────────────────────────────

describe("room code helpers", () => {
  it("accepts exactly 4 characters from the unambiguous alphabet", () => {
    expect(ROOM_CODE_LENGTH).toBe(4);
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    // The ambiguous characters are deliberately absent.
    for (const ch of "IO01") {
      expect(ROOM_CODE_ALPHABET).not.toContain(ch);
    }
    for (const code of ["K7P4", "X9QA", "ABCD", "WXYZ", "2345"]) {
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  it("rejects wrong length, lowercase, whitespace and alien characters", () => {
    for (const bad of [
      "",          // empty
      "K7P",       // too short
      "K7P44",     // too long
      "k7p4",      // not yet normalized (lowercase)
      "K7P4 ",     // trailing whitespace
      " K7P4",     // leading whitespace
      "K7P0",      // 0 excluded
      "K7P1",      // 1 excluded
      "K7PI",      // I excluded
      "K7PO",      // O excluded
      "K7P-",      // punctuation
      "K7Pü",      // non-ASCII
    ]) {
      expect(isValidRoomCode(bad)).toBe(false);
    }
  });

  it("normalizes player input: uppercase + strip ALL whitespace", () => {
    expect(normalizeRoomCode("K7P4")).toBe("K7P4");
    expect(normalizeRoomCode("k7p4")).toBe("K7P4");
    expect(normalizeRoomCode("  k7p4  ")).toBe("K7P4");
    expect(normalizeRoomCode("k7 p4")).toBe("K7P4"); // space INSIDE
    expect(normalizeRoomCode("\tk7\np4\r")).toBe("K7P4");
    expect(normalizeRoomCode("k 7 p 4")).toBe("K7P4");
    expect(normalizeRoomCode("abcd")).toBe("ABCD");
    // Anything that cannot become a well-formed code is null.
    expect(normalizeRoomCode("k7 p0")).toBeNull(); // 0 stays excluded
    expect(normalizeRoomCode("k7p")).toBeNull(); // too short
    expect(normalizeRoomCode("k7p44")).toBeNull(); // too long
    expect(normalizeRoomCode("")).toBeNull();
    expect(normalizeRoomCode("   ")).toBeNull();
  });

  it("generateUniqueRoomCode retries collisions and fails when exhausted", () => {
    const taken = new Set(["AAAA", "AAAB", "AAAC"]);
    // The scripted factory offers taken codes first, then a free one.
    const code = generateUniqueRoomCode(
      (c) => taken.has(c),
      scriptedFactory("AAAA", "AAAB", "AAAC", "AAAD")
    );
    expect(code).toBe("AAAD");

    // A permanently-taken space fails loudly instead of looping forever.
    expect(() =>
      generateUniqueRoomCode(() => true, () => "ZZZZ")
    ).toThrow(/unique room code/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Generation: every room gets a valid, active-unique code
// ────────────────────────────────────────────────────────────────────────

describe("room code generation", () => {
  it("assigns every new room a well-formed, active-unique code", () => {
    const server = newServer();
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const session = server.connect();
      const created = mustSeat(server.createRoom(session));
      expect(created.room.code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(created.room.code)).toBe(true);
      expect(created.room.code).toBe(created.room.code.toUpperCase());
      // The internal id is a different, non-player-facing identifier.
      expect(created.room.id).not.toBe(created.room.code);
      // Uniqueness among ACTIVE rooms (10 draws over ~1M codes).
      expect(codes.has(created.room.code)).toBe(false);
      codes.add(created.room.code);
    }
    expect(server.roomCount()).toBe(10);
  });

  it("retries a colliding code until it draws a free one", () => {
    const manager = createRoomManager({
      roomCodeFactory: scriptedFactory("AAAA", "AAAA", "BBBB"),
    });
    liveManagers.push(manager);

    const first = mustSeat(manager.createRoom("host-1"));
    expect(first.room.code).toBe("AAAA");
    // The second room's first draw (AAAA) collides with the ACTIVE room;
    // it must retry and land on the next candidate.
    const second = mustSeat(manager.createRoom("host-2"));
    expect(second.room.code).toBe("BBBB");
    expect(manager.roomCount()).toBe(2);
  });

  it("fails loudly if no free code can be drawn (no partial room)", () => {
    const manager = createRoomManager({ roomCodeFactory: () => "AAAA" });
    liveManagers.push(manager);

    mustSeat(manager.createRoom("host-1"));
    expect(() => manager.createRoom("host-2")).toThrow(/unique room code/);
    // The failed create left nothing behind: still exactly one room, and
    // the second session never took a seat.
    expect(manager.roomCount()).toBe(1);
    expect(mustSeat(manager.joinRoom("guest", "AAAA")).playerId).toBe("p1");
  });

  it("never generates sequential or clock-derived codes (random draws)", () => {
    // Two managers, created back to back, must not hand out "incrementing"
    // codes (0000, 0001, …): with the crypto generator the first codes of
    // independent rooms are unrelated draws from the 32^4 space.
    const a = createRoomManager();
    const b = createRoomManager();
    liveManagers.push(a, b);

    const codeA = mustSeat(a.createRoom("s1")).room.code;
    const codeB = mustSeat(b.createRoom("s2")).room.code;
    // Chance that two independent uniform draws are equal: ~1/1 048 576.
    // The point is not the (astronomically weak) equality check — it is
    // that NEITHER code is the sequential "first" code of the alphabet.
    expect(codeA).not.toBe(codeB);
    expect(codeA).not.toBe("AAAA");
    expect(codeB).not.toBe("AAAA");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Joining by code
// ────────────────────────────────────────────────────────────────────────

describe("joining by room code", () => {
  it("joins a waiting room by its exact code", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;

    const guest = server.connect();
    const joined = mustSeat(server.joinRoom(guest, code));
    expect(joined.playerId).toBe("p1");
    expect(joined.room.code).toBe(code);
    expect(joined.room.id).toBe(created.room.id);
  });

  it("normalizes case and whitespace on join (k7 p4 → K7P4)", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;
    const [head, tail] = [code.slice(0, 2), code.slice(2)];

    const variants = [
      code.toLowerCase(),               // lowercase
      `  ${code}  `,                    // padded
      `${head.toLowerCase()} ${tail}`,  // space INSIDE, lowercase head
      `\t${head}\n${tail}\r`,           // exotic whitespace
    ];
    for (const variant of variants) {
      const guest = server.connect();
      const joined = mustSeat(server.joinRoom(guest, variant));
      expect(joined.room.code).toBe(code);
      expect(joined.room.id).toBe(created.room.id);
      // The seat is freed again between variants so the room stays joinable.
      expect(server.leaveRoom(guest).ok).toBe(true);
    }
  });

  it("still accepts the internal room id (server-internal compat)", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));

    // The internal UUID path keeps working for existing/privileged callers.
    const guest = server.connect();
    const joined = mustSeat(server.joinRoom(guest, created.room.id));
    expect(joined.playerId).toBe("p1");

    // getRoom resolves both namespaces to the same room.
    const byCode = server.getRoom(created.room.code);
    const byId = server.getRoom(created.room.id);
    expect(byCode?.id).toBe(created.room.id);
    expect(byCode?.code).toBe(created.room.code);
    expect(byId?.code).toBe(created.room.code);
  });

  it("rejects malformed and unknown codes indistinguishably (unknown-room)", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));

    const badIdentifiers = [
      "K7P",        // too short
      "K7P44",      // too long
      "K7P0",       // excluded character 0
      "K7P1",       // excluded character 1
      "K7PI",       // excluded character I
      "K7PO",       // excluded character O
      "k7p4-lol",   // punctuation
      "ZZ9Z",       // well-formed but no such room
      "",           // empty
    ];
    for (const identifier of badIdentifiers) {
      const guest = server.connect();
      const joined = server.joinRoom(guest, identifier);
      // Every failure mode looks the same from outside: no information
      // about WHICH codes exist leaks, and the wire reason is unchanged.
      expect(joined).toEqual({ ok: false, reason: "unknown-room" });
    }
    // The room is untouched and still joinable by its real code.
    const guest = server.connect();
    expect(mustSeat(server.joinRoom(guest, created.room.code)).playerId).toBe("p1");
  });

  it("code joins go through the normal room rules (capacity/state)", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;

    // Fill the room to 4/4 by code.
    for (let i = 1; i < 4; i++) {
      const guest = server.connect();
      expect(mustSeat(server.joinRoom(guest, code)).playerId).toBe(`p${i}`);
    }
    // A fifth joiner (by code) hits the ordinary capacity rule.
    const fifth = server.connect();
    expect(server.joinRoom(fifth, code)).toEqual({ ok: false, reason: "room-full" });

    // Once playing, joining by the code is refused like any other join.
    expect(server.startMatch(created.room.id).ok).toBe(true);
    const late = server.connect();
    expect(server.joinRoom(late, code)).toEqual({ ok: false, reason: "room-playing" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Lifecycle: stability while alive, reuse after destruction
// ────────────────────────────────────────────────────────────────────────

describe("room code lifecycle", () => {
  it("the code is stable for the room's whole lifetime", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;

    const guest = server.connect();
    mustSeat(server.joinRoom(guest, code));
    expect(server.getRoom(code)?.code).toBe(code);

    // Snapshot right before and right after the match starts.
    expect(server.startMatch(server.getRoom(code)!.id).ok).toBe(true);
    const playing = server.getRoom(code);
    expect(playing?.code).toBe(code);
    expect(playing?.id).toBe(created.room.id);
  });

  it("a destroyed room releases its code — and the code stops resolving", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;

    // The last seated session leaves → the empty room is destroyed.
    expect(server.leaveRoom(host).ok).toBe(true);
    expect(server.roomCount()).toBe(0);
    expect(server.getRoom(code)).toBeNull();

    // The released code is immediately reusable by a future room.
    const manager = createRoomManager({ roomCodeFactory: () => code });
    liveManagers.push(manager);
    const reborn = mustSeat(manager.createRoom("fresh-host"));
    expect(reborn.room.code).toBe(code);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reconnect: codes change nothing about seat recovery
// ────────────────────────────────────────────────────────────────────────

describe("reconnect (unchanged by room codes)", () => {
  it("the reconnect credential — not the code — recovers the same seat", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;

    const guest = server.connect();
    const joined = mustSeat(server.joinRoom(guest, code));
    expect(joined.playerId).toBe("p1");
    // The credential is opaque and unrelated to the room code: a code is a
    // LOCATOR, never an authentication secret.
    expect(joined.reconnectToken).toBeTruthy();
    expect(joined.reconnectToken).not.toBe(code);
    expect(joined.reconnectToken).not.toBe(created.room.id);

    // The guest's connection drops: the seat is reserved, then recovered
    // with the credential on a fresh connection — exactly as before codes.
    expect(server.reserve(guest).ok).toBe(true);
    const recovered = server.reconnect(joined.reconnectToken);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.playerId).toBe("p1");
    expect(recovered.room.id).toBe(created.room.id); // same room, internally
    expect(recovered.room.code).toBe(code);          // same player-facing code
    expect(recovered.reconnectToken).toBe(joined.reconnectToken);
  });

  it("the room code is not a credential: it cannot reconnect anyone", () => {
    const server = newServer();
    const host = server.connect();
    const created = mustSeat(server.createRoom(host));
    const code = created.room.code;

    // Presenting the code (in any casing) as a reconnect credential fails
    // exactly like any other wrong credential — no seat is revealed.
    for (const fake of [code, code.toLowerCase(), ` ${code} `]) {
      expect(server.reconnect(fake)).toEqual({ ok: false, reason: "invalid-reconnect" });
    }
    expect(server.roomCount()).toBe(1); // nothing was disturbed
  });
});
