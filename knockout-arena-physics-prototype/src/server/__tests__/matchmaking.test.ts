import { describe, expect, it } from "vitest";
import { MAX_PLAYERS, createRoomManager } from "../roomManager";
import { createGameServer } from "../gameServer";

/**
 * PUBLIC MATCHMAKING / QUICK-JOIN (Task 17).
 *
 * Matchmaking is a thin room-CHOOSING policy on top of the existing
 * seating machinery: once a player is seated, a public room is an
 * ordinary room. These tests pin the choosing rules, the namespace
 * separation from private rooms, and the concurrency invariant that
 * makes simultaneous joins safe.
 */

function manager() {
  return createRoomManager();
}

/** Distinct session tokens, as the session layer would hand out. */
const tokens = (n: number, prefix = "s") =>
  Array.from({ length: n }, (_, i) => `${prefix}-token-${i}`);

// ── choosing a room ──────────────────────────────────────────────────────

describe("public join with no public rooms available", () => {
  it("creates a new public room and seats the player first", () => {
    const m = manager();
    const result = m.joinPublicRoom("alice");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.playerId).toBe("p0");
    expect(result.room.visibility).toBe("public");
    expect(result.room.state).toBe("waiting");
    expect(m.roomCount()).toBe(1);
  });

  it("makes the creator the host, exactly like a private room", () => {
    const m = manager();
    const result = m.joinPublicRoom("alice");
    expect(result.ok && result.room.hostPlayerId).toBe("p0");
  });

  it("ignores existing PRIVATE rooms when looking for a game", () => {
    const m = manager();
    m.createRoom("host-private"); // an open, waiting, private room
    const result = m.joinPublicRoom("alice");

    expect(result.ok && result.room.visibility).toBe("public");
    // The private room was not joined; a new public one was made.
    expect(m.roomCount()).toBe(2);
  });
});

describe("public join with an open public room", () => {
  it("joins the existing room instead of creating another", () => {
    const m = manager();
    const first = m.joinPublicRoom("alice");
    const second = m.joinPublicRoom("bob");

    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.room.id).toBe(first.room.id);
    expect(second.playerId).toBe("p1");
    expect(m.roomCount()).toBe(1);
  });

  it("fills seats in order up to the cap in a single room", () => {
    const m = manager();
    const seats = tokens(MAX_PLAYERS).map((t) => {
      const r = m.joinPublicRoom(t);
      return r.ok ? r.playerId : "rejected";
    });

    expect(seats).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(m.roomCount()).toBe(1);
  });

  it("reuses a seat freed by someone leaving", () => {
    const m = manager();
    m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    m.leaveRoom("alice"); // frees p0, room survives (bob still seated)

    const late = m.joinPublicRoom("carol");
    expect(late.ok && late.playerId).toBe("p0");
    expect(m.roomCount()).toBe(1);
  });
});

describe("public join when the only public room is unavailable", () => {
  it("creates a second room once the first is full", () => {
    const m = manager();
    const all = tokens(MAX_PLAYERS + 1);
    const results = all.map((t) => m.joinPublicRoom(t));

    expect(results.every((r) => r.ok)).toBe(true);
    const firstRoom = results[0]!.ok ? results[0]!.room.id : "";
    const spilled = results[MAX_PLAYERS]!;
    expect(spilled.ok).toBe(true);
    if (!spilled.ok) return;

    expect(spilled.room.id).not.toBe(firstRoom);
    expect(spilled.playerId).toBe("p0"); // first seat of the new room
    expect(m.roomCount()).toBe(2);
  });

  it("creates a new room once the existing one has started", () => {
    const m = manager();
    const a = m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const started = m.startMatch(a.room.id);
    expect(started.ok).toBe(true);

    const late = m.joinPublicRoom("carol");
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(late.room.id).not.toBe(a.room.id);
    expect(late.playerId).toBe("p0");
    expect(m.roomCount()).toBe(2);
    m.destroy();
  });

  it("never seats a player into a room whose match is running", () => {
    const m = manager();
    const a = m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    if (!a.ok) return;
    m.startMatch(a.room.id);

    for (const t of tokens(3, "late")) {
      const r = m.joinPublicRoom(t);
      expect(r.ok && r.room.id).not.toBe(a.room.id);
    }
    m.destroy();
  });

  it("prefers the oldest open room so games fill up rather than scatter", () => {
    const m = manager();
    // Room A fills and starts; B is then created and stays open.
    const a = m.joinPublicRoom("a0");
    if (!a.ok) return;
    m.joinPublicRoom("a1");
    m.startMatch(a.room.id);
    const b = m.joinPublicRoom("b0");
    if (!b.ok) return;

    // A later joiner must land in B, not open a third room.
    const c = m.joinPublicRoom("c0");
    expect(c.ok && c.room.id).toBe(b.room.id);
    expect(m.roomCount()).toBe(2);
    m.destroy();
  });
});

// ── concurrency ──────────────────────────────────────────────────────────

describe("simultaneous public joins", () => {
  it("8 joins in one tick fill one room to 6 and spill 2, with no collisions", () => {
    const m = manager();
    // Everything in a single synchronous burst: no awaits, no timers —
    // the same interleaving the event loop gives a batch of socket
    // messages that arrive together.
    const results = tokens(8).map((t) => m.joinPublicRoom(t));

    expect(results.every((r) => r.ok)).toBe(true);
    const byRoom = new Map<string, string[]>();
    for (const r of results) {
      if (!r.ok) continue;
      const seats = byRoom.get(r.room.id) ?? [];
      seats.push(r.playerId);
      byRoom.set(r.room.id, seats);
    }

    expect(byRoom.size).toBe(2);
    const sizes = [...byRoom.values()].map((s) => s.length).sort((a, b) => b - a);
    expect(sizes).toEqual([6, 2]);

    // No seat handed out twice within a room.
    for (const seats of byRoom.values()) {
      expect(new Set(seats).size).toBe(seats.length);
    }
    // Exactly two rooms exist — no duplicate empties left behind.
    expect(m.roomCount()).toBe(2);
  });

  it("assigns 60 concurrent joins to exactly 10 full rooms", () => {
    const m = manager();
    const results = tokens(MAX_PLAYERS * 10).map((t) => m.joinPublicRoom(t));
    expect(results.every((r) => r.ok)).toBe(true);

    const byRoom = new Map<string, Set<string>>();
    for (const r of results) {
      if (!r.ok) continue;
      const seats = byRoom.get(r.room.id) ?? new Set<string>();
      // A duplicate seat id in the same room would collapse the set.
      expect(seats.has(r.playerId)).toBe(false);
      seats.add(r.playerId);
      byRoom.set(r.room.id, seats);
    }

    expect(byRoom.size).toBe(10);
    for (const seats of byRoom.values()) expect(seats.size).toBe(MAX_PLAYERS);
    expect(m.roomCount()).toBe(10);
  });

  it("never spawns a duplicate room when one open room would do", () => {
    const m = manager();
    // Five joins, one room's worth of space: exactly one room.
    tokens(5).forEach((t) => m.joinPublicRoom(t));
    expect(m.roomCount()).toBe(1);
  });

  it("leaves no empty rooms behind after a concurrent burst", () => {
    const m = manager();
    tokens(7).forEach((t) => m.joinPublicRoom(t));
    const before = m.roomCount();
    // removeEmptyRooms must find nothing to clean up.
    expect(m.removeEmptyRooms()).toBe(0);
    expect(m.roomCount()).toBe(before);
  });

  it("every concurrent joiner holds a seat the manager agrees with", () => {
    const m = manager();
    const all = tokens(8);
    const results = all.map((t) => m.joinPublicRoom(t));

    all.forEach((token, i) => {
      const claimed = results[i]!;
      const actual = m.resolveSeat(token);
      expect(actual).not.toBeNull();
      if (!claimed.ok || actual === null) return;
      // What the joiner was told matches the authoritative roster.
      expect(actual.playerId).toBe(claimed.playerId);
      expect(actual.room.id).toBe(claimed.room.id);
    });
  });

  it("is synchronous end to end — the safety argument's premise", () => {
    // The no-lock-needed claim rests on choose-then-seat never yielding.
    // If anyone makes this path async, joinPublicRoom starts returning a
    // Promise and this fails immediately.
    const m = manager();
    const result = m.joinPublicRoom("alice");
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).toBe("undefined");
  });
});

// ── namespace separation ─────────────────────────────────────────────────

describe("public and private rooms are separate namespaces", () => {
  it("a public room's code cannot be used in the join-by-code path", () => {
    const m = manager();
    const pub = m.joinPublicRoom("alice");
    expect(pub.ok).toBe(true);
    if (!pub.ok) return;

    const attempt = m.joinRoom("intruder", pub.room.code);
    expect(attempt).toEqual({ ok: false, reason: "unknown-room" });
  });

  it("a public room's internal id cannot be used either", () => {
    const m = manager();
    const pub = m.joinPublicRoom("alice");
    if (!pub.ok) return;

    // joinRoom accepts UUIDs for server-internal callers; a public room
    // must still be refused through it.
    expect(m.joinRoom("intruder", pub.room.id)).toEqual({
      ok: false,
      reason: "unknown-room",
    });
  });

  it("reports the SAME error as a genuinely unknown code (no leak)", () => {
    const m = manager();
    const pub = m.joinPublicRoom("alice");
    if (!pub.ok) return;

    const atPublic = m.joinRoom("intruder", pub.room.code);
    const atNothing = m.joinRoom("intruder", "ZZZZ");
    // Indistinguishable: a prober cannot tell a public room exists.
    expect(atPublic).toEqual(atNothing);
  });

  it("private rooms remain joinable by code, unchanged", () => {
    const m = manager();
    const priv = m.createRoom("host");
    expect(priv.ok).toBe(true);
    if (!priv.ok) return;
    expect(priv.room.visibility).toBe("private");

    const joined = m.joinRoom("friend", priv.room.code);
    expect(joined.ok).toBe(true);
    expect(joined.ok && joined.room.id).toBe(priv.room.id);
  });

  it("a private room is never handed out by matchmaking", () => {
    const m = manager();
    const priv = m.createRoom("host");
    if (!priv.ok) return;

    for (const t of tokens(3)) {
      const r = m.joinPublicRoom(t);
      expect(r.ok && r.room.id).not.toBe(priv.room.id);
    }
  });

  it("defaults to private so every pre-existing caller is unchanged", () => {
    const m = manager();
    const created = m.createRoom("host");
    expect(created.ok && created.room.visibility).toBe("private");
  });
});

// ── the seated player is an ordinary player ──────────────────────────────

describe("a matchmade player follows the normal flow", () => {
  it("starts a match through the ordinary host/start path", () => {
    const m = manager();
    const a = m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    if (!a.ok) return;

    // Same startMatch, same MIN_PLAYERS rule, same result shape.
    expect(m.startMatch(a.room.id).ok).toBe(true);
    expect(m.getRoom(a.room.id)?.state).toBe("playing");
    m.destroy();
  });

  it("respects the 2-player minimum exactly like a private room", () => {
    const m = manager();
    const solo = m.joinPublicRoom("alice");
    if (!solo.ok) return;
    expect(m.startMatch(solo.room.id)).toEqual({
      ok: false,
      reason: "not-enough-players",
    });
  });

  it("cannot exceed the 6-seat cap", () => {
    const m = manager();
    const first = m.joinPublicRoom("t0");
    if (!first.ok) return;
    tokens(MAX_PLAYERS - 1, "rest").forEach((t) => m.joinPublicRoom(t));

    // Direct join into the (now full) public room is refused, and the
    // room still holds exactly MAX_PLAYERS seats.
    expect(m.getRoom(first.room.id)?.seats.length).toBe(MAX_PLAYERS);
  });

  it("supports leaving, naming and reconnect-style reservation", () => {
    const m = manager();
    const a = m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    if (!a.ok) return;

    expect(m.setName("alice", "Ada").ok).toBe(true);
    expect(m.reserveSeat("alice").ok).toBe(true);
    expect(m.restoreSeat("alice").ok).toBe(true);
    expect(m.leaveRoom("alice").ok).toBe(true);
  });

  it("rejects a session that is already seated", () => {
    const m = manager();
    m.joinPublicRoom("alice");
    expect(m.joinPublicRoom("alice")).toEqual({
      ok: false,
      reason: "already-in-room",
    });
  });

  it("rejects an invalid session token", () => {
    const m = manager();
    expect(m.joinPublicRoom("")).toEqual({ ok: false, reason: "unknown-session" });
  });
});

// ── what happens to an emptied public room (Task 18) ─────────────────────

describe("an emptied public room is cleaned up", () => {
  it("is destroyed when its only player leaves", () => {
    const m = manager();
    const solo = m.joinPublicRoom("alice");
    expect(m.roomCount()).toBe(1);
    if (!solo.ok) return;

    m.leaveRoom("alice");
    // Existing detachSeat behaviour: empty rooms do not linger.
    expect(m.roomCount()).toBe(0);
    expect(m.getRoom(solo.room.id)).toBeNull();
  });

  it("does not leave a ghost room for the next matchmaker", () => {
    const m = manager();
    const first = m.joinPublicRoom("alice");
    if (!first.ok) return;
    m.leaveRoom("alice");

    // The next player gets a brand-new room, not the destroyed one.
    const next = m.joinPublicRoom("bob");
    expect(next.ok && next.room.id).not.toBe(first.room.id);
    expect(next.ok && next.playerId).toBe("p0");
    expect(m.roomCount()).toBe(1);
  });

  it("survives with a reduced roster when one of two leaves", () => {
    const m = manager();
    const a = m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    if (!a.ok) return;

    m.leaveRoom("alice");
    const room = m.getRoom(a.room.id);
    expect(room).not.toBeNull();
    expect(room?.seats.map((s) => s.playerId)).toEqual(["p1"]);
    // And it is still offered to the next matchmaking request.
    const carol = m.joinPublicRoom("carol");
    expect(carol.ok && carol.room.id).toBe(a.room.id);
  });

  it("frees the lowest seat for the next joiner", () => {
    const m = manager();
    const a = m.joinPublicRoom("alice");
    m.joinPublicRoom("bob");
    if (!a.ok) return;
    m.leaveRoom("alice"); // frees p0

    const carol = m.joinPublicRoom("carol");
    expect(carol.ok && carol.playerId).toBe("p0");
  });

  it("removeEmptyRooms finds nothing to do after a clean leave", () => {
    const m = manager();
    m.joinPublicRoom("alice");
    m.leaveRoom("alice");
    expect(m.removeEmptyRooms()).toBe(0);
    expect(m.roomCount()).toBe(0);
  });
});

// ── through the game server facade ───────────────────────────────────────

describe("the facade issues credentials like any other join", () => {
  it("returns a reconnect credential for a matchmade seat", () => {
    const server = createGameServer();
    const session = server.connect();
    const result = server.joinPublicRoom(session);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.reconnectToken).toBe("string");
    expect(result.reconnectToken.length).toBeGreaterThan(20);
    expect(result.room.visibility).toBe("public");
  });

  it("seats two facade sessions into the same public room", () => {
    const server = createGameServer();
    const a = server.joinPublicRoom(server.connect());
    const b = server.joinPublicRoom(server.connect());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.room.id).toBe(a.room.id);
    expect(b.playerId).toBe("p1");
  });

  it("rejects an unknown session", () => {
    const server = createGameServer();
    expect(server.joinPublicRoom({ token: "nope" })).toEqual({
      ok: false,
      reason: "unknown-session",
    });
  });

  it("the credential reconnects into the public room", () => {
    const server = createGameServer();
    const joined = server.joinPublicRoom(server.connect());
    if (!joined.ok) return;
    const again = server.reconnect(joined.reconnectToken);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.room.id).toBe(joined.room.id);
    expect(again.playerId).toBe(joined.playerId);
  });
});
