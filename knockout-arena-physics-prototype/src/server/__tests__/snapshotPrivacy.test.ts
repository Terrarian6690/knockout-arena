import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type GameStateSnapshot } from "../../game";
import { createGameServer, type GameServer, type Session } from "../index";

/**
 * Snapshot PRIVACY and REVEAL at the real server boundary (onRoomView —
 * exactly what crosses the wire to each client). The projection is
 * viewer-specific; these tests pin that the wire itself carries the
 * privacy contract, not just the UI:
 *
 *  - during the aiming round, each viewer's snapshot carries ONLY their
 *    own aim/power. The other players' pawns expose nothing but public
 *    readiness — there is no field a hostile client could read another
 *    player's direction from (Task 13 labels 9, 10, 11);
 *  - once the round resolves, every viewer receives the committed
 *    launches of all confirmed players (12) and no launch for
 *    unconfirmed ones (13);
 *  - a disconnected-but-confirmed player's launch is revealed exactly
 *    like anyone else's — the datum lives in the match state, never in
 *    a connection (17);
 *  - a player who reconnects mid-round receives the CURRENT
 *    authoritative view: their own aim back, the other player's aim
 *    still private (18).
 *
 * Everything here is synchronous command/response — no real waiting.
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

function makeRoom(
  server: GameServer,
  n: number
): { roomId: string; sessions: Session[]; tokens: string[] } {
  const sessions: Session[] = [];
  const tokens: string[] = [];
  const creator = server.connect();
  const created = server.createRoom(creator);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  sessions.push(creator);
  tokens.push(created.reconnectToken);
  const roomId = created.room.id;
  for (let i = 1; i < n; i++) {
    const s = server.connect();
    const joined = server.joinRoom(s, roomId);
    expect(joined.ok).toBe(true);
    if (!joined.ok) throw new Error("unreachable");
    sessions.push(s);
    tokens.push(joined.reconnectToken);
  }
  return { roomId, sessions, tokens };
}

/** Capture every view pushed to one session (subscribe pushes at once). */
function viewSink(server: GameServer, session: Session): GameStateSnapshot[] {
  const views: GameStateSnapshot[] = [];
  server.onRoomView(session, (view) => {
    views.push(view);
  });
  return views;
}

const last = (views: GameStateSnapshot[]): GameStateSnapshot => {
  const view = views[views.length - 1];
  if (view === undefined) throw new Error("no view was pushed");
  return view;
};

describe("snapshot privacy and reveal (onRoomView)", () => {
  it("during aiming, each viewer's snapshot carries ONLY their own aim (9, 10, 11)", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);

    const asP0 = viewSink(server, sessions[0]);
    const asP1 = viewSink(server, sessions[1]);

    // Both players aim in opposite directions (p0 top → down, p1 bottom → up).
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: 450, y: 550 }).ok
    ).toBe(true);
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: 450, y: 150 }).ok
    ).toBe(true);

    // p0 has locked in: readiness is public, direction is not.
    expect(
      server.submitCommand(sessions[0], {
        type: "setPower",
        power: 2,
      }).ok
    ).toBe(true);
    expect(
      server.submitCommand(sessions[0], { type: "confirmLaunch" }).ok
    ).toBe(true);

    const view0 = last(asP0);
    const view1 = last(asP1);
    expect(view0.phase).toBe("aiming");
    expect(view1.phase).toBe("aiming");

    // Each viewer sees their OWN current direction…
    expect(view0.aimDirection).toEqual({ x: 0, y: 1 }); // p0 aimed down
    expect(view1.aimDirection).toEqual({ x: 0, y: -1 }); // p1 aimed up
    expect(view0.power).toBe(2); // own (just-confirmed) power

    // …and the other player's pawn exposes ONLY public facts — there is
    // no per-pawn aim/power field on the wire at all (structural privacy:
    // hiding it is not left to the UI).
    for (const view of [view0, view1]) {
      for (const pawn of view.pawns) {
        expect(pawn.launch).toBeNull();
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
      // 11: readiness IS public — the deciding/waiting state is visible.
      expect(view.pawns.find((p) => p.id === "p0")!.confirmed).toBe(true);
      expect(view.pawns.find((p) => p.id === "p1")!.confirmed).toBe(false);
    }
  });

  it("resolution reveals the confirmed launch to EVERY viewer; the unconfirmed player carries none (12, 13)", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);
    const asP0 = viewSink(server, sessions[0]);
    const asP1 = viewSink(server, sessions[1]);

    // Only p0 commits a choice (down, power 3); p1 stays silent.
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: 450, y: 550 }).ok
    ).toBe(true);
    expect(
      server.submitCommand(sessions[0], {
        type: "setPower",
        power: 3,
      }).ok
    ).toBe(true);
    expect(
      server.submitCommand(sessions[0], { type: "confirmLaunch" }).ok
    ).toBe(true);

    // The server resolves the round (the deadline's privileged path).
    expect(server.resolveRound(roomId)).toEqual({ ok: true });

    for (const views of [asP0, asP1]) {
      const view = last(views);
      expect(view.phase).toBe("moving");
      // The committed launch — exact direction and power — is public now.
      expect(view.pawns.find((p) => p.id === "p0")!.launch).toEqual({
        direction: { x: 0, y: 1 },
        power: 3,
      });
      // The silent player launched nothing; no fake direction exists.
      expect(view.pawns.find((p) => p.id === "p1")!.launch).toBeNull();
    }
  });

  it("a DISCONNECTED-but-confirmed player's launch is revealed normally during movement (17)", () => {
    const server = newServer();
    const { roomId, sessions } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);

    // p0 commits, then their connection dies (the seat is reserved).
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: 450, y: 550 }).ok
    ).toBe(true);
    expect(
      server.submitCommand(sessions[0], { type: "confirmLaunch" }).ok
    ).toBe(true);
    expect(server.reserve(sessions[0])).toEqual({ ok: true }); // the drop
    expect(server.getRoom(roomId)!.seats[0]).toEqual({
      playerId: "p0",
      connected: false,
    });

    // The round resolves while p0 is gone. The committed launch lives in
    // the match state — the remaining viewer still sees it revealed.
    const asP1 = viewSink(server, sessions[1]);
    expect(server.resolveRound(roomId)).toEqual({ ok: true });
    const view = last(asP1);
    expect(view.phase).toBe("moving");
    expect(view.pawns.find((p) => p.id === "p0")!.launch).toEqual({
      direction: { x: 0, y: 1 },
      power: CONFIG.power.default,
    });
  });

  it("a reconnected viewer gets the CURRENT authoritative view: own aim back, the other player's aim still private (18)", () => {
    const server = newServer();
    const { roomId, sessions, tokens } = makeRoom(server, 2);
    expect(server.startMatch(roomId).ok).toBe(true);

    // Both aim; p0 drops and reconnects mid-round.
    expect(
      server.submitCommand(sessions[0], { type: "aim", x: 450, y: 550 }).ok
    ).toBe(true);
    expect(
      server.submitCommand(sessions[1], { type: "aim", x: 450, y: 150 }).ok
    ).toBe(true);
    expect(server.reserve(sessions[0])).toEqual({ ok: true });
    const recovered = server.reconnect(tokens[0]);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error("unreachable");

    // The fresh subscription's immediate push is the CURRENT state —
    // no stale anything, and p1's aim is still nowhere in it.
    const asRecovered = viewSink(server, recovered.session);
    expect(asRecovered.length).toBeGreaterThan(0);
    const view = last(asRecovered);
    expect(view.phase).toBe("aiming");
    expect(view.localPawnId).toBe("p0"); // the same seat's own projection
    expect(view.aimDirection).toEqual({ x: 0, y: 1 }); // own aim, restored
    expect(view.pawns.find((p) => p.id === "p1")!.launch).toBeNull();
    // And the aiming round itself was untouched: the deadline metadata is
    // still stamped (same armed window — reconnect reset nothing).
    expect(typeof view.roundDeadline).toBe("number");
  });
});
