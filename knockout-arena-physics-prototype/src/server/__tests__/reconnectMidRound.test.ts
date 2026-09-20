import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  projectSnapshot,
  type GameState,
} from "../../game";
import { createGameServer, type GameServer, type SeatedResult } from "../index";
import type { Session } from "../session";

/**
 * RECONNECTION DURING AN ACTIVE DECISION PHASE (Task 13).
 *
 * reconnect.test.ts covers credentials, reservations and identity. This
 * suite covers the case that matters for fairness: a player drops
 * MID-ROUND, while they (or others) are still deciding.
 *
 * What these tests pin:
 *
 *   - a drop after aiming but BEFORE confirming preserves the locked
 *     aim and power server-side — the player resumes exactly where they
 *     were, neither losing their choice nor gaining a free re-pick;
 *   - a drop is NOT a confirm: the round does not advance on their
 *     behalf, and they can still confirm after reconnecting;
 *   - peers never see the dropped player's aim or power at any point,
 *     only the public fact that the seat is disconnected;
 *   - when the reservation expires mid-aim the seat follows the NORMAL
 *     leave rules (no special case, no abandoned-aim leak) and the
 *     credential stops working;
 *   - a reconnect landing after the round already resolved receives the
 *     CURRENT state as its first push — never a stale round.
 */

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

const liveServers: GameServer[] = [];
function newServer(options?: { reconnectReservationMs?: number }): GameServer {
  const server = createGameServer({ randomSkinIndex: () => 0, ...options });
  liveServers.push(server);
  return server;
}
afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
});

function okSeat(result: SeatedResult): {
  roomId: string;
  playerId: string;
  reconnectToken: string;
} {
  if (!result.ok) throw new Error(`seat failed: ${result.reason}`);
  return {
    roomId: result.room.id,
    playerId: result.playerId,
    reconnectToken: result.reconnectToken,
  };
}

function makeRoom(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[]; tokens: string[] } {
  const sessions: Session[] = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = okSeat(server.createRoom(creator));
  sessions.push(creator);
  tokens.push(created.reconnectToken);
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = okSeat(server.joinRoom(s, created.roomId));
    sessions.push(s);
    tokens.push(joined.reconnectToken);
  }
  return { roomId: created.roomId, sessions, tokens };
}

function statePipe(server: GameServer, session: Session): string[] {
  const received: string[] = [];
  server.onRoomState(session, (s) => received.push(s));
  return received;
}

function latestState(received: string[]): GameState {
  const last = received[received.length - 1];
  if (!last) throw new Error("no state received yet");
  return deserializeGameState(last);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

function overTheRim(pawn: { position: { x: number; y: number } }): {
  x: number;
  y: number;
} {
  const dx = pawn.position.x - CX || 1;
  const dy = pawn.position.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  return { x: CX + (dx / len) * 400, y: CY + (dy / len) * 400 };
}

/** Start a 3-player match and return everything the tests need. */
function startedMatch(options?: { reconnectReservationMs?: number }) {
  const server = newServer(options);
  const { roomId, sessions, tokens } = makeRoom(server, 3);
  const pipes = sessions.map((s) => statePipe(server, s));
  expect(server.startMatch(roomId).ok).toBe(true);
  return { server, roomId, sessions, tokens, pipes };
}

/** The pawn state of `playerId` in the newest pushed state. */
function pawnOf(pipe: string[], playerId: string) {
  const pawn = latestState(pipe).pawns.find((p) => p.id === playerId);
  if (!pawn) throw new Error(`no pawn ${playerId}`);
  return pawn;
}

// ────────────────────────────────────────────────────────────────────────
// Drop after locking an aim, before confirming
// ────────────────────────────────────────────────────────────────────────

describe("dropping mid-decision after locking an aim", () => {
  it("preserves the locked aim and power across the reconnect", () => {
    const { server, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[1]!;

    const pawnBefore = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawnBefore) });
    server.submitCommand(victim, { type: "setPower", power: 5 });

    const aimed = pawnOf(pipes[1]!, "p1");
    expect(aimed.aim.active).toBe(true);
    expect(aimed.power).toBe(5);
    expect(aimed.confirmed).toBe(false);
    const lockedDirection = { ...aimed.aim.direction };

    // The connection drops: a reservation opens, no engine call is made.
    expect(server.reserve(victim)).toEqual({ ok: true });

    const reconnected = server.reconnect(tokens[1]!);
    expect(reconnected.ok).toBe(true);
    if (!reconnected.ok) throw new Error("unreachable");
    expect(reconnected.playerId).toBe("p1");

    // The engine state is untouched by the round trip.
    const after = pawnOf(pipes[1]!, "p1");
    expect(after.aim.active).toBe(true);
    expect(after.aim.direction.x).toBeCloseTo(lockedDirection.x, 9);
    expect(after.aim.direction.y).toBeCloseTo(lockedDirection.y, 9);
    expect(after.power).toBe(5);
  });

  it("does not treat the drop as a confirmation", () => {
    const { server, sessions, pipes } = startedMatch();
    const victim = sessions[1]!;
    server.submitCommand(victim, { type: "setPower", power: 4 });
    server.reserve(victim);

    expect(pawnOf(pipes[0]!, "p1").confirmed).toBe(false);
    // The round is still open: the other players are not forced onward.
    expect(latestState(pipes[0]!).phase).toBe("aiming");
  });

  it("lets the reconnected player confirm and play the round normally", () => {
    const { server, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });
    server.reserve(victim);

    const result = server.reconnect(tokens[1]!);
    if (!result.ok) throw new Error("reconnect failed");

    // Same session object identity — commands work without re-seating.
    expect(server.submitCommand(result.session, { type: "confirmLaunch" }).ok).toBe(
      true
    );
    expect(pawnOf(pipes[1]!, "p1").confirmed).toBe(true);
  });

  it("keeps the viewer's own projection self-consistent after reconnect", () => {
    // The client rehydrates from this projection: it must show the
    // player's OWN aim and power, not a blank decision state.
    const { server, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 2 });
    server.reserve(victim);
    expect(server.reconnect(tokens[1]!).ok).toBe(true);

    const snapshot = projectSnapshot(latestState(pipes[1]!), "p1");
    expect(snapshot.localPawnId).toBe("p1");
    expect(snapshot.power).toBe(2);
    expect(snapshot.aimDirection).not.toBeNull();
    expect(snapshot.isAiming).toBe(true);
    expect(snapshot.phase).toBe("aiming");
  });

  it("survives repeated drops without corrupting the choice", () => {
    // Flaky connections re-reserve; the window restarts, the state must not.
    const { server, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 3 });
    const locked = { ...pawnOf(pipes[1]!, "p1").aim.direction };

    for (let i = 0; i < 3; i += 1) {
      expect(server.reserve(victim)).toEqual({ ok: true });
      const r = server.reconnect(tokens[1]!);
      expect(r.ok).toBe(true);
    }

    const after = pawnOf(pipes[1]!, "p1");
    expect(after.power).toBe(3);
    expect(after.aim.direction.x).toBeCloseTo(locked.x, 9);
    expect(after.aim.direction.y).toBeCloseTo(locked.y, 9);
    expect(after.confirmed).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// What peers can see
// ────────────────────────────────────────────────────────────────────────

describe("peers during a teammate's drop and reconnect", () => {
  it("never receive the dropped player's aim or power", () => {
    const { server, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });
    server.reserve(victim);
    server.reconnect(tokens[1]!);

    // Every state a peer received, projected the way that peer sees it.
    for (const serialized of pipes[0]!) {
      const snapshot = projectSnapshot(deserializeGameState(serialized), "p0");
      if (snapshot.phase !== "aiming") continue;
      for (const p of snapshot.pawns) {
        if (p.id === "p0") continue;
        expect(p.launch).toBeNull();
        expect(p).not.toHaveProperty("aim");
        expect(p).not.toHaveProperty("power");
      }
    }
  });

  it("see readiness only as the public confirmed flag", () => {
    // Readiness is public by design; the CHOICE behind it is not.
    const { server, sessions, pipes } = startedMatch();
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });
    server.submitCommand(victim, { type: "confirmLaunch" });
    server.reserve(victim);

    const snapshot = projectSnapshot(latestState(pipes[0]!), "p0");
    const other = snapshot.pawns.find((p) => p.id === "p1")!;
    expect(other.confirmed).toBe(true);
    expect(other.launch).toBeNull(); // still aiming phase → no reveal
  });

  it("do not receive the dropped player's reconnect credential", () => {
    const { server, roomId, sessions, tokens, pipes } = startedMatch();
    server.reserve(sessions[1]!);
    const everything = JSON.stringify({
      states: pipes[0],
      room: server.getRoom(roomId),
    });
    expect(everything).not.toContain(tokens[1]!);
  });

  it("see the seat reported disconnected while it is reserved", () => {
    const { server, roomId, sessions } = startedMatch();
    server.reserve(sessions[1]!);
    const seat = server.getRoom(roomId)!.seats.find((s) => s.playerId === "p1");
    expect(seat).toBeDefined();
    expect(seat!.connected).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reservation expiry while mid-aim
// ────────────────────────────────────────────────────────────────────────

describe("the reservation expiring while the player was mid-aim", () => {
  it("releases the seat exactly like a non-responder, leaking nothing", async () => {
    const { server, roomId, sessions, tokens, pipes } = startedMatch({
      reconnectReservationMs: 60,
    });
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });
    server.reserve(victim);

    // NOTE: reconnect() is the success path — polling with it would
    // reclaim the seat and cancel the reservation under test. Wait out
    // the window on the clock, then probe exactly once.
    await new Promise((r) => setTimeout(r, 400));

    // The credential is dead. Task 14: its own bearer now learns WHY
    // (the seat timed out) — a guessed token still gets the generic
    // "invalid-reconnect", so nothing is leaked to anyone else.
    expect(server.reconnect(tokens[1]!)).toEqual({
      ok: false,
      reason: "reservation-expired",
    });

    // The roster is frozen mid-match: the seat stays listed, reported
    // disconnected (the pawn remains in the running match).
    const seat = server.getRoom(roomId)!.seats.find((s) => s.playerId === "p1");
    expect(seat?.connected).toBe(false);

    // No abandoned aim is revealed to anyone still playing.
    const snapshot = projectSnapshot(latestState(pipes[0]!), "p0");
    const abandoned = snapshot.pawns.find((p) => p.id === "p1")!;
    expect(abandoned.launch).toBeNull();
    expect(abandoned.confirmed).toBe(false);
  });

  it("leaves the match itself playable for everyone else", async () => {
    const { server, sessions, tokens, pipes } = startedMatch({
      reconnectReservationMs: 60,
    });
    server.reserve(sessions[1]!);
    await new Promise((r) => setTimeout(r, 400));
    expect(server.reconnect(tokens[1]!).ok).toBe(false);

    // The remaining players can still act; the phase is still a real one.
    expect(latestState(pipes[0]!).phase).toBe("aiming");
    expect(server.submitCommand(sessions[0]!, { type: "setPower", power: 2 }).ok).toBe(
      true
    );
  });

  it("does not special-case the abandoned aim in the serialized state", async () => {
    // Whatever the engine keeps internally, nothing may mark the seat as
    // "had a pending aim" in a way peers could read.
    const { server, sessions, tokens, pipes } = startedMatch({
      reconnectReservationMs: 60,
    });
    const victim = sessions[1]!;
    const pawn = pawnOf(pipes[1]!, "p1");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });
    server.reserve(victim);
    await new Promise((r) => setTimeout(r, 400));
    expect(server.reconnect(tokens[1]!).ok).toBe(false);

    const projected = projectSnapshot(latestState(pipes[0]!), "p0");
    const text = JSON.stringify(projected);
    expect(text).not.toContain("abandoned");
    expect(text).not.toContain("reserved");
    const other = projected.pawns.find((p) => p.id === "p1")!;
    expect(Object.keys(other)).not.toContain("aim");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reconnecting after the round already moved on
// ────────────────────────────────────────────────────────────────────────

describe("reconnecting after the round has already resolved", () => {
  it("delivers the CURRENT state as the first push, never a stale round", async () => {
    const { server, roomId, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[2]!;
    const pawn = pawnOf(pipes[2]!, "p2");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });

    const roundBefore = latestState(pipes[0]!).round.number;
    server.reserve(victim);

    // The remaining players finish the round without them.
    for (const [i, s] of [sessions[0]!, sessions[1]!].entries()) {
      server.submitCommand(s, { type: "aim", x: CX + i, y: CY });
      server.submitCommand(s, { type: "setPower", power: 1 });
      server.submitCommand(s, { type: "confirmLaunch" });
    }
        server.resolveRound(roomId);
    await waitFor(
      () => latestState(pipes[0]!).phase === "aiming" &&
            (latestState(pipes[0]!).round.number ?? 0) > (roundBefore ?? 0),
      4000
    );
    const roundNow = latestState(pipes[0]!).round.number;
    expect(roundNow).toBeGreaterThan(roundBefore ?? 0);

    // Reconnect and subscribe the way the transport does: the first push
    // a fresh listener receives must already be the CURRENT state.
    const result = server.reconnect(tokens[2]!);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const freshPipe = statePipe(server, result.session);

    expect(freshPipe.length).toBeGreaterThan(0);
    const first = deserializeGameState(freshPipe[0]!);
    expect(first.round.number).toBe(roundNow);
    expect(first.phase).toBe(latestState(pipes[0]!).phase);
  });

  it("starts the new round unconfirmed, with no aim carried over", async () => {
    const { server, roomId, sessions, tokens, pipes } = startedMatch();
    const victim = sessions[2]!;
    const pawn = pawnOf(pipes[2]!, "p2");
    server.submitCommand(victim, { type: "aim", ...overTheRim(pawn) });
    server.submitCommand(victim, { type: "setPower", power: 5 });
    server.submitCommand(victim, { type: "confirmLaunch" });
    const roundBefore = latestState(pipes[0]!).round.number ?? 0;
    server.reserve(victim);

    for (const s of [sessions[0]!, sessions[1]!]) {
      server.submitCommand(s, { type: "setPower", power: 1 });
      server.submitCommand(s, { type: "confirmLaunch" });
    }
        server.resolveRound(roomId);
    await waitFor(
      () =>
        latestState(pipes[0]!).phase === "aiming" &&
        (latestState(pipes[0]!).round.number ?? 0) > roundBefore,
      4000
    );

    const result = server.reconnect(tokens[2]!);
    if (!result.ok) throw new Error("reconnect failed");
    const fresh = deserializeGameState(statePipe(server, result.session)[0]!);
    const mine = fresh.pawns.find((p) => p.id === "p2")!;
    // A NEW aiming round: the previous round's confirmation is cleared.
    expect(mine.confirmed).toBe(false);
    // A fresh aiming round has no committed launch. The ENGINE field is
    // `lastLaunch` (the snapshot's `launch` is the projected view of it);
    // asserting the snapshot name here would silently pass on undefined.
    expect(mine.lastLaunch).toBeNull();
  });

  it("gives the reconnecting player the same round number as everyone else", async () => {
    const { server, roomId, sessions, tokens, pipes } = startedMatch();
    server.reserve(sessions[2]!);
    for (const s of [sessions[0]!, sessions[1]!]) {
      server.submitCommand(s, { type: "setPower", power: 1 });
      server.submitCommand(s, { type: "confirmLaunch" });
    }
        server.resolveRound(roomId);
    await waitFor(() => latestState(pipes[0]!).phase === "aiming", 4000);

    const result = server.reconnect(tokens[2]!);
    if (!result.ok) throw new Error("reconnect failed");
    const fresh = deserializeGameState(statePipe(server, result.session)[0]!);
    expect(fresh.round.number).toBe(latestState(pipes[0]!).round.number);
  });
});
