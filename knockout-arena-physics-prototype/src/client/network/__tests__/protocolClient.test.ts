import { describe, expect, it } from "vitest";
import {
  commandMessage,
  commandPayload,
  createRoomMessage,
  joinRoomMessage,
  leaveRoomMessage,
  parseServerMessage,
  reconnectMessage,
  startMatchMessage,
} from "../protocolClient";

/**
 * The browser client's end of wire protocol v1 — pure parsing and message
 * building. Total-function guarantees: malformed input resolves to a
 * rejection, never a throw. (The server's own builders are exercised
 * against this parser in the integration suite.)
 */

describe("client→server message builders", () => {
  it("builds the room operation envelopes exactly", () => {
    expect(JSON.parse(createRoomMessage())).toEqual({
      protocolVersion: 1,
      type: "create_room",
    });
    expect(JSON.parse(joinRoomMessage("room-123"))).toEqual({
      protocolVersion: 1,
      type: "join_room",
      roomId: "room-123",
    });
    expect(JSON.parse(leaveRoomMessage())).toEqual({
      protocolVersion: 1,
      type: "leave_room",
    });
    expect(JSON.parse(startMatchMessage())).toEqual({
      protocolVersion: 1,
      type: "start_match",
    });
    expect(JSON.parse(reconnectMessage("opaque-credential"))).toEqual({
      protocolVersion: 1,
      type: "reconnect",
      token: "opaque-credential",
    });
  });

  it("rebuilds intents from known fields only — forged playerIds and extras are dropped", () => {
    expect(
      commandPayload({ type: "aim", playerId: "p9", x: 10, y: 20, hack: true })
    ).toEqual({ type: "aim", x: 10, y: 20 });
    expect(
      commandPayload({ type: "setPower", playerId: "p1", power: 5, extra: 1 })
    ).toEqual({ type: "setPower", power: 5 });
    expect(commandPayload({ type: "confirmLaunch", playerId: "p0" })).toEqual({
      type: "confirmLaunch",
    });
  });

  it("refuses non-intents — reset is server-only", () => {
    expect(commandPayload({ type: "reset" })).toBeNull();
    expect(commandPayload({ type: "teleport", x: 0, y: 0 })).toBeNull();
    expect(commandPayload(null)).toBeNull();
    expect(commandPayload(42)).toBeNull();
    expect(commandPayload("aim")).toBeNull();
    expect(commandPayload({})).toBeNull();
    // Hostile getters must not throw.
    expect(
      commandPayload({
        get type() {
          throw new Error("boom");
        },
      })
    ).toBeNull();
  });

  it("builds command envelopes with the cleaned payload", () => {
    const raw = commandMessage({ type: "aim", playerId: "p9", x: 1, y: 2 });
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      protocolVersion: 1,
      type: "command",
      command: { type: "aim", x: 1, y: 2 },
    });
    expect(commandMessage({ type: "reset" })).toBeNull();
  });
});

describe("server→client message parsing", () => {
  const welcome = JSON.stringify({
    protocolVersion: 1,
    type: "welcome",
    roomId: "r1",
    playerId: "p2",
    roomState: "waiting",
    roster: [
      { playerId: "p0", connected: true },
      { playerId: "p2", connected: true },
    ],
    hostPlayerId: "p0",
  });

  it("parses welcome", () => {
    const parsed = parseServerMessage(welcome);
    expect(parsed).toEqual({
      ok: true,
      message: {
        type: "welcome",
        roomId: "r1",
        playerId: "p2",
        roomState: "waiting",
        roster: [
          { playerId: "p0", connected: true },
          { playerId: "p2", connected: true },
        ],
        hostPlayerId: "p0",
      },
    });
  });

  it("parses a welcome carrying a reconnect credential (and one without)", () => {
    const withToken = parseServerMessage(
      JSON.stringify({
        protocolVersion: 1,
        type: "welcome",
        roomId: "r1",
        playerId: "p2",
        roomState: "waiting",
        roster: [{ playerId: "p0", connected: true }],
        hostPlayerId: "p0",
        reconnectToken: "cred-abc",
      })
    );
    expect(withToken).toEqual({
      ok: true,
      message: {
        type: "welcome",
        roomId: "r1",
        playerId: "p2",
        roomState: "waiting",
        roster: [{ playerId: "p0", connected: true }],
        hostPlayerId: "p0",
        reconnectToken: "cred-abc",
      },
    });

    // Absent credential (older server): valid, just no recovery path.
    const withoutToken = parseServerMessage(welcome);
    expect(withoutToken.ok).toBe(true);
    if (withoutToken.ok && withoutToken.message.type === "welcome") {
      expect(withoutToken.message.reconnectToken).toBeUndefined();
    }

    // Malformed credential: rejected.
    for (const bad of [42, "", { nested: true }]) {
      const parsed = parseServerMessage(
        JSON.stringify({
          protocolVersion: 1,
          type: "welcome",
          roomId: "r1",
          playerId: "p2",
          roomState: "waiting",
          roster: [{ playerId: "p0", connected: true }],
          hostPlayerId: "p0",
          reconnectToken: bad,
        })
      );
      expect(parsed).toMatchObject({ ok: false, code: "malformed-payload" });
    }
  });

  it("parses room_state (roomId optional)", () => {
    for (const raw of [
      JSON.stringify({
        protocolVersion: 1,
        type: "room_state",
        roomId: "r1",
        roomState: "playing",
        roster: [],
        hostPlayerId: null,
      }),
      JSON.stringify({
        protocolVersion: 1,
        type: "room_state",
        roomState: "finished",
        roster: [{ playerId: "p0", connected: false }],
        hostPlayerId: "p0",
      }),
    ]) {
      expect(parseServerMessage(raw).ok).toBe(true);
    }
    const parsed = parseServerMessage(
      JSON.stringify({
        protocolVersion: 1,
        type: "room_state",
        roomId: "r1",
        roomState: "playing",
        roster: [],
        hostPlayerId: null,
      })
    );
    if (!parsed.ok || parsed.message.type !== "room_state") throw new Error("unreachable");
    expect(parsed.message.roomId).toBe("r1");
  });

  it("parses snapshot", () => {
    const snapshot = {
      phase: "aiming",
      pawns: [{ id: "p0", isLocal: true }],
      localPawnId: "p0",
      winnerId: null,
      power: 3,
      aimDirection: null,
      isAiming: false,
      activePawnId: "p0",
    };
    const parsed = parseServerMessage(
      JSON.stringify({ protocolVersion: 1, type: "snapshot", state: snapshot })
    );
    expect(parsed).toEqual({ ok: true, message: { type: "snapshot", state: snapshot } });
  });

  it("parses a snapshot carrying the round decision deadline (and tolerates it absent)", () => {
    const base = {
      phase: "aiming",
      pawns: [{ id: "p0", isLocal: true }],
      localPawnId: "p0",
      winnerId: null,
      power: 3,
      aimDirection: null,
      isAiming: false,
    };
    // The server stamps an ABSOLUTE deadline on aiming snapshots; null
    // means no aiming round is in progress. Both pass through untouched.
    const withDeadline = { ...base, roundDeadline: 1_788_453_655_341 };
    const parsed = parseServerMessage(
      JSON.stringify({ protocolVersion: 1, type: "snapshot", state: withDeadline })
    );
    expect(parsed).toEqual({
      ok: true,
      message: { type: "snapshot", state: withDeadline },
    });
    const nulled = { ...base, roundDeadline: null };
    const parsedNull = parseServerMessage(
      JSON.stringify({ protocolVersion: 1, type: "snapshot", state: nulled })
    );
    expect(parsedNull).toEqual({ ok: true, message: { type: "snapshot", state: nulled } });
    // Older servers send no deadline field at all — still a valid snapshot.
    const parsedAbsent = parseServerMessage(
      JSON.stringify({ protocolVersion: 1, type: "snapshot", state: base })
    );
    expect(parsedAbsent).toEqual({ ok: true, message: { type: "snapshot", state: base } });
  });

  it("parses match_finished (winner and no-survivor)", () => {
    expect(
      parseServerMessage(
        JSON.stringify({ protocolVersion: 1, type: "match_finished", winnerId: "p1" })
      )
    ).toEqual({ ok: true, message: { type: "match_finished", winnerId: "p1" } });
    expect(
      parseServerMessage(
        JSON.stringify({ protocolVersion: 1, type: "match_finished", winnerId: null })
      )
    ).toEqual({ ok: true, message: { type: "match_finished", winnerId: null } });
  });

  it("parses error", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          protocolVersion: 1,
          type: "error",
          code: "room-full",
          message: "the room is full (4 players)",
        })
      )
    ).toEqual({
      ok: true,
      message: { type: "error", code: "room-full", message: "the room is full (4 players)" },
    });
  });

  it("rejects malformed JSON, null, arrays and primitives", () => {
    for (const junk of ["{nope", "null", "[]", "[1]", "42", '"hi"', "true", ""]) {
      const parsed = parseServerMessage(junk);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("malformed-message");
    }
  });

  it("rejects missing and unsupported protocol versions", () => {
    for (const raw of [
      JSON.stringify({ type: "welcome" }),
      JSON.stringify({ protocolVersion: 2, type: "welcome" }),
      JSON.stringify({ protocolVersion: "1", type: "welcome" }),
    ]) {
      const parsed = parseServerMessage(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("unsupported-protocol");
    }
  });

  it("rejects unknown message types", () => {
    const parsed = parseServerMessage(
      JSON.stringify({ protocolVersion: 1, type: "frobnicate" })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe("unknown-message-type");
  });

  it("rejects malformed payloads", () => {
    const cases: Array<Record<string, unknown>> = [
      // welcome without roomId/playerId, bad roomState, bad roster, bad host
      { protocolVersion: 1, type: "welcome", playerId: "p0", roomState: "waiting", roster: [], hostPlayerId: null },
      { protocolVersion: 1, type: "welcome", roomId: "r", playerId: "p0", roomState: "lobby", roster: [], hostPlayerId: null },
      { protocolVersion: 1, type: "welcome", roomId: "r", playerId: "p0", roomState: "waiting", roster: "many", hostPlayerId: null },
      { protocolVersion: 1, type: "welcome", roomId: "r", playerId: "p0", roomState: "waiting", roster: [{ playerId: "p0", connected: "yes" }], hostPlayerId: null },
      { protocolVersion: 1, type: "welcome", roomId: "r", playerId: "p0", roomState: "waiting", roster: [], hostPlayerId: 3 },
      // room_state without a roomState
      { protocolVersion: 1, type: "room_state", roster: [], hostPlayerId: null },
      // snapshot without a state / without pawns / bad localPawnId
      { protocolVersion: 1, type: "snapshot" },
      { protocolVersion: 1, type: "snapshot", state: { phase: "aiming" } },
      { protocolVersion: 1, type: "snapshot", state: { phase: "aiming", pawns: [], localPawnId: 7 } },
      // match_finished without winnerId
      { protocolVersion: 1, type: "match_finished" },
      // error without code
      { protocolVersion: 1, type: "error", message: "hi" },
    ];
    for (const message of cases) {
      const parsed = parseServerMessage(JSON.stringify(message));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("malformed-payload");
    }
  });
});
