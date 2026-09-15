import { afterEach, describe, expect, it } from "vitest";
import { createGameServer, type GameServer } from "../gameServer";
import type { Session } from "../session";
import { AUTO_START_MS_BY_PLAYERS } from "../roomManager";

/**
 * AUTO-START IN PUBLIC ROOMS (Task 28).
 *
 * Quick-play rooms have no host-controlled start any more. The server
 * arms a countdown the moment a public room holds two seated players and
 * starts the match itself when it expires. The wait shortens as the room
 * fills: 2→5min, 3→3.5min, 4→1min, 5→20s, 6→3s.
 *
 * THE RE-ARM RULE, pinned here because it is a judgment call:
 *
 *   - a countdown only ever moves EARLIER. The table value for the new
 *     player count is a candidate; the deadline becomes the minimum of
 *     the candidate and whatever was already armed. An arriving player
 *     therefore never pushes the match back.
 *   - a full room's countdown is therefore COMMITTED for free: once six
 *     players pulled it in to three seconds, no departure can push it
 *     back out (every smaller count's value is later, so the minimum
 *     keeps the committed deadline).
 *   - dropping below two players cancels it outright — a lock cannot
 *     keep a match scheduled for a room that no longer has opponents.
 *
 * Private rooms are untouched by every test here: they keep the manual
 * host start and never arm a countdown.
 */

const liveServers: GameServer[] = [];
function newServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

/** Seat `n` sessions in one public room; returns the room id + sessions. */
function publicRoom(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[] } {
  const sessions: Session[] = [];
  let roomId = "";
  for (let i = 0; i < n; i++) {
    const session = server.connect();
    const result = server.joinPublicRoom(session);
    if (!result.ok) throw new Error(`seat ${i} failed: ${result.reason}`);
    roomId = result.room.id;
    sessions.push(session);
  }
  return { roomId, sessions };
}

/** A private room with `n` players (the creator first). */
function privateRoom(
  server: GameServer,
  n: number
): { roomId: string; code: string; sessions: Session[] } {
  const creator = server.connect();
  const created = server.createRoom(creator);
  if (!created.ok) throw new Error("createRoom failed");
  const sessions = [creator];
  for (let i = 1; i < n; i++) {
    const session = server.connect();
    const joined = server.joinRoom(session, created.room.code);
    if (!joined.ok) throw new Error(`join ${i} failed: ${joined.reason}`);
    sessions.push(session);
  }
  return { roomId: created.room.id, code: created.room.code, sessions };
}

/** Remaining milliseconds on the armed countdown (throws if none). */
function remaining(server: GameServer, roomId: string): number {
  const deadline = server.autoStartDeadline(roomId);
  if (deadline === null) throw new Error("no countdown is armed");
  return deadline - Date.now();
}

/** Assert a duration is the table value for `players`, within tolerance. */
function expectTableValue(actualMs: number, players: number): void {
  const expected = AUTO_START_MS_BY_PLAYERS[players]!;
  expect(actualMs).toBeGreaterThan(expected - 1_000);
  expect(actualMs).toBeLessThanOrEqual(expected);
}

// ── arming ───────────────────────────────────────────────────────────────

describe("a public room arms its countdown at two players", () => {
  it("one player alone has no countdown", () => {
    const server = newServer();
    const { roomId } = publicRoom(server, 1);

    expect(server.autoStartDeadline(roomId)).toBeNull();
    expect(server.getRoom(roomId)!.autoStartDeadline).toBeNull();
    expect(server.getRoom(roomId)!.state).toBe("waiting");
  });

  it("the second player arms a five-minute countdown", () => {
    const server = newServer();
    const { roomId } = publicRoom(server, 2);

    expectTableValue(remaining(server, roomId), 2);
    expect(AUTO_START_MS_BY_PLAYERS[2]).toBe(300_000);
  });

  it("the deadline is an absolute timestamp, not a duration", () => {
    // The client renders time left from this; it must be a wall-clock
    // instant in the future, not "300000".
    const server = newServer();
    const { roomId } = publicRoom(server, 2);
    const deadline = server.autoStartDeadline(roomId)!;

    expect(deadline).toBeGreaterThan(Date.now());
    expect(deadline).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("is published on RoomInfo so transports can broadcast it", () => {
    const server = newServer();
    const { roomId } = publicRoom(server, 2);

    expect(server.getRoom(roomId)!.autoStartDeadline).toBe(
      server.autoStartDeadline(roomId)
    );
  });
});

// ── the table, and the clamp rule ────────────────────────────────────────

describe("each new player shortens the wait", () => {
  it("re-arms to the table value at 3, 4, 5 and 6 players", () => {
    const server = newServer();
    const { roomId } = publicRoom(server, 2);
    expectTableValue(remaining(server, roomId), 2);

    for (const count of [3, 4, 5, 6]) {
      const session = server.connect();
      const result = server.joinPublicRoom(session);
      expect(result.ok).toBe(true);
      // Each arrival's table value is shorter than the previous one, so
      // the clamp always adopts it.
      expectTableValue(remaining(server, roomId), count);
    }
  });

  it("the full room still gets a visible three seconds, not an instant start", () => {
    const server = newServer();
    const { roomId } = publicRoom(server, 6);

    const left = remaining(server, roomId);
    expect(left).toBeGreaterThan(1_500); // enough to see and render
    expect(left).toBeLessThanOrEqual(3_000);
    // Crucially it has NOT started yet: the countdown is real.
    expect(server.getRoom(roomId)!.state).toBe("waiting");
  });

  it("a join never pushes the deadline back (clamp to the earlier one)", () => {
    // The rule that matters: nobody can delay a match by arriving. Here
    // the room is at 6 (3s) and a departure to 5 must not restore 20s.
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 6);
    const atSix = server.autoStartDeadline(roomId)!;

    server.leaveRoom(sessions[5]!);
    const afterLeave = server.autoStartDeadline(roomId)!;

    // Committed at full: the 3s deadline is untouched.
    expect(afterLeave).toBe(atSix);
    expect(remaining(server, roomId)).toBeLessThanOrEqual(3_000);
  });

  it("a room keeps its earlier deadline when a player leaves", () => {
    // 3 players (210s) → one leaves → 2 players. The table says 300s but
    // the countdown only ever moves earlier, so 210s stands.
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 3);
    const atThree = server.autoStartDeadline(roomId)!;
    expectTableValue(remaining(server, roomId), 3);

    server.leaveRoom(sessions[2]!);

    expect(server.getRoom(roomId)!.seats).toHaveLength(2);
    expect(server.autoStartDeadline(roomId)).toBe(atThree);
    // Not re-lengthened to the 2-player value.
    expect(remaining(server, roomId)).toBeLessThanOrEqual(210_000);
  });
});

// ── cancelation ──────────────────────────────────────────────────────────

describe("the countdown is canceled when the room cannot play", () => {
  it("dropping below two players cancels it outright", () => {
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 2);
    expect(server.autoStartDeadline(roomId)).not.toBeNull();

    server.leaveRoom(sessions[1]!);

    expect(server.autoStartDeadline(roomId)).toBeNull();
    expect(server.getRoom(roomId)!.state).toBe("waiting");
  });

  it("re-arms from scratch when a second player returns", () => {
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 2);
    server.leaveRoom(sessions[1]!);
    expect(server.autoStartDeadline(roomId)).toBeNull();

    const returning = server.connect();
    server.joinPublicRoom(returning);

    // A fresh 5 minutes — the canceled countdown left nothing behind.
    expectTableValue(remaining(server, roomId), 2);
  });

  it("a departure from a full room cannot lengthen its countdown", () => {
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 6);
    server.leaveRoom(sessions[0]!);

    // Still armed (5 players is well above the minimum) and still short.
    expect(server.autoStartDeadline(roomId)).not.toBeNull();
    expect(remaining(server, roomId)).toBeLessThanOrEqual(3_000);
  });

  it("a committed full-room countdown is still canceled below two", () => {
    // The monotonic rule defers to the floor: no opponents, no match.
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 6);
    for (let i = 5; i >= 1; i--) server.leaveRoom(sessions[i]!);

    expect(server.getRoom(roomId)!.seats).toHaveLength(1);
    expect(server.autoStartDeadline(roomId)).toBeNull();
  });
});

// ── firing ───────────────────────────────────────────────────────────────

describe("the match starts by itself", () => {
  it("starts when the countdown reaches zero, with no player action", async () => {
    // A full room's 3 s is the fastest real path to zero.
    const server = newServer();
    const { roomId } = publicRoom(server, 6);
    expect(server.getRoom(roomId)!.state).toBe("waiting");

    await new Promise((resolve) => setTimeout(resolve, 3_300));

    // Nobody sent start_match — the server did this on its own.
    expect(server.getRoom(roomId)!.state).toBe("playing");
    // And the countdown is spent, not left dangling.
    expect(server.autoStartDeadline(roomId)).toBeNull();
  });

  it("notifies subscribers so the transport can broadcast", async () => {
    const server = newServer();
    const seen: string[] = [];
    server.onAutoStart((room) => seen.push(room.state));
    const { roomId } = publicRoom(server, 6);

    await new Promise((resolve) => setTimeout(resolve, 3_300));

    expect(seen).toEqual(["playing"]);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  });

  it("does not fire for a room that emptied while pending", async () => {
    const server = newServer();
    const { roomId, sessions } = publicRoom(server, 6);
    // Drop to one player before the 3 s elapses.
    for (let i = 5; i >= 1; i--) server.leaveRoom(sessions[i]!);

    await new Promise((resolve) => setTimeout(resolve, 3_300));

    expect(server.getRoom(roomId)!.state).toBe("waiting");
  });
});

// ── private rooms are untouched ──────────────────────────────────────────

describe("private rooms keep the manual host start", () => {
  it("never arm a countdown, at any player count", () => {
    const server = newServer();
    for (const n of [1, 2, 3, 6]) {
      const { roomId } = privateRoom(server, n);
      expect(server.autoStartDeadline(roomId)).toBeNull();
      expect(server.getRoom(roomId)!.autoStartDeadline).toBeNull();
    }
  });

  it("still wait indefinitely for the host to start", async () => {
    const server = newServer();
    const { roomId } = privateRoom(server, 6);

    // Well past the 3 s a full PUBLIC room would have taken.
    await new Promise((resolve) => setTimeout(resolve, 3_300));

    expect(server.getRoom(roomId)!.state).toBe("waiting");
  });

  it("start on demand, exactly as before", () => {
    const server = newServer();
    const { roomId } = privateRoom(server, 2);

    const result = server.startMatch(roomId);

    expect(result.ok).toBe(true);
    expect(server.getRoom(roomId)!.state).toBe("playing");
  });
});

// ── interaction with the rematch flow (Task 25) ──────────────────────────

describe("the countdown and the room lifecycle (Task 25)", () => {
  it("no countdown survives into the running match", async () => {
    // The armed timer is consumed by the start it caused: a live match
    // must not carry a pending auto-start.
    const server = newServer();
    const { roomId } = publicRoom(server, 6);
    await new Promise((resolve) => setTimeout(resolve, 3_300));

    expect(server.getRoom(roomId)!.state).toBe("playing");
    expect(server.autoStartDeadline(roomId)).toBeNull();
    expect(server.getRoom(roomId)!.autoStartDeadline).toBeNull();
  });

  it("a playing room refuses to reopen, so nothing re-arms mid-match", () => {
    // Task 25's guard is unchanged by this task: only a FINISHED match
    // can be dismissed, so an auto-started match cannot be cut short by
    // a return-to-lobby racing the countdown.
    const server = newServer();
    const { roomId } = publicRoom(server, 2);
    server.startMatch(roomId); // the countdown would have done this later

    const returned = server.returnToLobby(roomId);

    expect(returned).toEqual({ ok: false, reason: "already-playing" });
    expect(server.getRoom(roomId)!.state).toBe("playing");
    expect(server.autoStartDeadline(roomId)).toBeNull();
  });

  it("a private room that reopens still waits for its host", () => {
    // reopenRoom runs for both kinds of room; only the public one arms.
    const server = newServer();
    const { roomId } = privateRoom(server, 2);

    // A waiting room reopens as a no-op success (Task 25's contract).
    expect(server.returnToLobby(roomId).ok).toBe(true);

    expect(server.getRoom(roomId)!.state).toBe("waiting");
    expect(server.autoStartDeadline(roomId)).toBeNull();
  });

  it("a public room that reopens arms a fresh countdown", () => {
    // The same no-op reopen on a PUBLIC room must leave a countdown
    // armed — this is the path a rematch takes back to the lobby.
    const server = newServer();
    const { roomId } = publicRoom(server, 2);

    expect(server.returnToLobby(roomId).ok).toBe(true);

    expect(server.getRoom(roomId)!.state).toBe("waiting");
    expectTableValue(remaining(server, roomId), 2);
  });
});
