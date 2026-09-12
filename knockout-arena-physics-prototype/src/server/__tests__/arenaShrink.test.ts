import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG,
  deserializeGameState,
  type GameStateSnapshot,
} from "../../game";
import { createGameServer, type GameServer, type Session } from "../index";
import { createGameHost, type GameHost } from "../gameHost";

/**
 * The shrinking arena AT THE SERVER BOUNDARY — the authoritative path.
 *
 * Task 5 requires that the shrink is server-side, that all clients learn
 * the arena size from the authoritative snapshot, and that no client
 * timer decides anything. These tests exercise the real server pieces:
 *
 *   - GameHost: the headless authoritative owner of a match. Its
 *     serialized state carries the radius + schedule, and the host's
 *     round deadline is the countdown clients display;
 *   - GameServer.onRoomView: exactly what crosses the wire to each
 *     client — every viewer gets the same arena, including a player who
 *     subscribes LATE (the reconnect case).
 *
 * Nothing here counts rounds client-side: the assertions read what the
 * server sent.
 */

const EVERY = CONFIG.arena.shrink.everyRounds;
const INITIAL = CONFIG.arena.radius;
const STEP = CONFIG.arena.shrink.amount;
const TICK = CONFIG.simulation.fixedTimestepMs;

const liveServers: GameServer[] = [];
const liveHosts: GameHost[] = [];

afterEach(() => {
  for (const server of liveServers) server.destroy();
  liveServers.length = 0;
  for (const host of liveHosts) host.destroy();
  liveHosts.length = 0;
});

function newServer(): GameServer {
  const server = createGameServer();
  liveServers.push(server);
  return server;
}

function newHost(clock: () => number): GameHost {
  const host = createGameHost({
    players: [
      { id: "p0", name: "A", colorIndex: 0 },
      { id: "p1", name: "B", colorIndex: 1 },
    ],
    clock,
  });
  liveHosts.push(host);
  return host;
}

/** Room with n seated players and a started match. */
function makeMatch(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[] } {
  const sessions: Session[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  if (!created.ok) throw new Error("createRoom failed");
  sessions.push(creator);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, roomId);
    if (!joined.ok) throw new Error("joinRoom failed");
    sessions.push(s);
  }
  expect(server.startMatch(roomId).ok).toBe(true);
  return { roomId, sessions };
}

/** Capture every view pushed to one session. */
function viewSink(server: GameServer, session: Session): GameStateSnapshot[] {
  const views: GameStateSnapshot[] = [];
  server.onRoomView(session, (view) => views.push(view));
  return views;
}

const last = (views: GameStateSnapshot[]): GameStateSnapshot => {
  const view = views[views.length - 1];
  if (view === undefined) throw new Error("no view was pushed");
  return view;
};

describe("GameHost: the arena shrinks inside the authoritative match state", () => {
  it("serializes the initial radius and the schedule counter", () => {
    const host = newHost(() => 0);
    const state = deserializeGameState(host.serializedState());
    expect(state.arena).toEqual({ radius: INITIAL, roundsSinceShrink: 0 });
  });

  it("shrinks after N server-resolved rounds — and broadcasts the new state", () => {
    let now = 0;
    const host = newHost(() => now);
    const pushes: string[] = [];
    host.onStateChange((s) => pushes.push(s));

    const radiusNow = () =>
      deserializeGameState(host.serializedState()).arena!.radius;

    for (let round = 1; round <= EVERY; round++) {
      expect(host.submitCommand({ type: "resolveRound" }).ok).toBe(true);
      // Tick until the round has settled and a new aiming round opened.
      for (let i = 0; i < 2000; i++) {
        if (deserializeGameState(host.serializedState()).phase !== "moving") {
          break;
        }
        now += TICK;
        host.tick();
      }
      expect(radiusNow()).toBe(round < EVERY ? INITIAL : INITIAL - STEP);
    }

    // The shrink reached subscribers as ordinary authoritative state —
    // no side channel, no separate "shrink" message.
    const lastPush = deserializeGameState(pushes[pushes.length - 1]);
    expect(lastPush.arena!.radius).toBe(INITIAL - STEP);
    expect(lastPush.arena!.roundsSinceShrink).toBe(0);
  });

  it("arms a fresh round deadline for the round that triggers the shrink", () => {
    // The countdown clients display IS the round deadline: the shrink
    // lands when this round resolves, so the same authoritative timer
    // serves both. It must be re-armed per round, never client-held.
    let now = 1_000;
    const host = newHost(() => now);
    const first = host.roundDeadline();
    expect(first).toBe(now + 10_000); // the 10 s aiming deadline, preserved

    expect(host.submitCommand({ type: "resolveRound" }).ok).toBe(true);
    expect(host.roundDeadline()).toBeNull(); // no deadline while resolving

    for (let i = 0; i < 2000; i++) {
      if (deserializeGameState(host.serializedState()).phase !== "moving") break;
      now += TICK;
      host.tick();
    }
    const second = host.roundDeadline();
    expect(second).not.toBeNull();
    expect(second).toBeGreaterThan(first!); // a NEW window for the new round
  });
});

describe("onRoomView: every client receives the authoritative arena", () => {
  it("stamps the current radius and countdown on each viewer's snapshot", () => {
    const server = newServer();
    const { sessions } = makeMatch(server, 2);
    const asP0 = viewSink(server, sessions[0]);
    const asP1 = viewSink(server, sessions[1]);

    for (const view of [last(asP0), last(asP1)]) {
      expect(view.arena).toEqual({
        radius: INITIAL,
        roundsUntilShrink: EVERY,
        nextRadius: INITIAL - STEP,
        shrinkWarning: false,
        atMinRadius: false,
      });
      // The countdown material is authoritative too: an absolute
      // server timestamp, not a client-side duration.
      expect(typeof view.roundDeadline).toBe("number");
    }
  });

  it("gives every viewer the SAME arena (no per-client computation)", () => {
    const server = newServer();
    const { sessions } = makeMatch(server, 3);
    const sinks = sessions.map((s) => viewSink(server, s));
    // Provoke a push so all sinks hold a fresh view.
    expect(server.submitCommand(sessions[0], { type: "aim", x: 450, y: 550 }).ok).toBe(
      true
    );
    const arenas = sinks.map((sink) => last(sink).arena);
    for (const arena of arenas) expect(arena).toEqual(arenas[0]);
  });

  it("a LATE subscriber (reconnect) immediately gets the current arena state", () => {
    const server = newServer();
    const { sessions } = makeMatch(server, 2);
    // p1 subscribes only now — the push on subscribe must already carry
    // the authoritative arena, so a reconnecting client never has to
    // guess or wait for the next change.
    const late = viewSink(server, sessions[1]);
    expect(late.length).toBeGreaterThan(0);
    expect(last(late).arena).toEqual({
      radius: INITIAL,
      roundsUntilShrink: EVERY,
      nextRadius: INITIAL - STEP,
      shrinkWarning: false,
      atMinRadius: false,
    });
  });

  it("keeps the arena out of the privacy-sensitive per-pawn payload", () => {
    // The arena is match-wide public geometry; adding it must not have
    // widened what a pawn reveals during aiming.
    const server = newServer();
    const { sessions } = makeMatch(server, 2);
    const asP0 = viewSink(server, sessions[0]);
    expect(server.submitCommand(sessions[1], { type: "aim", x: 450, y: 150 }).ok).toBe(
      true
    );
    const view = last(asP0);
    for (const pawn of view.pawns) {
      expect(Object.keys(pawn).sort()).toEqual(
        [
          "id",
          "name",
          "position",
          "velocity",
          "radius",
          "eliminated",
          "confirmed",
          "launch",
          "isLocal",
          "colorIndex",
        ].sort()
      );
    }
  });
});
