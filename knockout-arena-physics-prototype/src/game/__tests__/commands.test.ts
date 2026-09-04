import { describe, expect, it } from "vitest";
import { createGame } from "../game";
import { projectSnapshot } from "../project";
import {
  validateCommand,
  withPlayerId,
  type GameCommand,
  type PlayerIntent,
} from "../commands";

/**
 * UPDATED for the simultaneous-round command model: every ACTION command
 * carries a `playerId` (structural requirement), and the engine adds the
 * rejection reasons `unknown-player`, `wrong-player` (eliminated) and
 * `already-confirmed` (choice locked for the round). `resolveRound` joins
 * `reset` as a match-level, player-less command (the server's decision
 * deadline). Commands must be attributable to a player so the authoritative
 * server can validate ownership instead of trusting the client.
 */

const P0 = "p0";

describe("validateCommand — valid commands", () => {
  it("accepts an aim command with finite coordinates", () => {
    expect(validateCommand({ type: "aim", playerId: P0, x: 450, y: 300 })).toEqual({ ok: true });
  });

  it("accepts negative and zero aim coordinates", () => {
    expect(validateCommand({ type: "aim", playerId: P0, x: -10, y: 0 })).toEqual({ ok: true });
  });

  it("accepts a setPower command with any finite number", () => {
    // Clamping/rounding is engine policy, not structural validation.
    expect(validateCommand({ type: "setPower", playerId: P0, power: 3 })).toEqual({ ok: true });
    expect(validateCommand({ type: "setPower", playerId: P0, power: 2.5 })).toEqual({ ok: true });
    expect(validateCommand({ type: "setPower", playerId: P0, power: 99 })).toEqual({ ok: true });
    expect(validateCommand({ type: "setPower", playerId: P0, power: -1 })).toEqual({ ok: true });
  });

  it("accepts confirmLaunch, resolveRound and reset", () => {
    expect(validateCommand({ type: "confirmLaunch", playerId: P0 })).toEqual({ ok: true });
    expect(validateCommand({ type: "resolveRound" })).toEqual({ ok: true });
    expect(validateCommand({ type: "reset" })).toEqual({ ok: true });
  });
});

describe("validateCommand — invalid commands", () => {
  it("rejects non-object input", () => {
    for (const bad of [null, undefined, 42, "aim", true, []]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects unknown command types", () => {
    for (const bad of [
      {},
      { type: "bogus" },
      { type: "" },
      { type: 7 },
    ]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects action commands without a playerId", () => {
    // Ownership is structural: a command that names no sender is malformed.
    for (const bad of [
      { type: "aim", x: 450, y: 300 },
      { type: "setPower", power: 3 },
      { type: "confirmLaunch" },
      { type: "aim", playerId: "", x: 1, y: 2 },
      { type: "setPower", playerId: 7, power: 3 },
      { type: "confirmLaunch", playerId: null },
    ]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects aim commands with missing or non-finite fields", () => {
    for (const bad of [
      { type: "aim", playerId: P0 },
      { type: "aim", playerId: P0, x: 450 },
      { type: "aim", playerId: P0, y: 300 },
      { type: "aim", playerId: P0, x: NaN, y: 300 },
      { type: "aim", playerId: P0, x: 450, y: Infinity },
      { type: "aim", playerId: P0, x: "450", y: 300 },
      { type: "aim", playerId: P0, x: null, y: null },
    ]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects setPower commands with missing or non-finite power", () => {
    for (const bad of [
      { type: "setPower", playerId: P0 },
      { type: "setPower", playerId: P0, power: NaN },
      { type: "setPower", playerId: P0, power: Infinity },
      { type: "setPower", playerId: P0, power: "5" },
    ]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("never throws, whatever it is given", () => {
    const junk = [
      Symbol("x"),
      new Date(),
      { type: "aim", playerId: P0, x: Number.MAX_VALUE, y: -Number.MAX_VALUE },
      { type: { nested: true } },
      { type: "aim", playerId: P0, get x() { throw new Error("boom"); } },
    ];
    for (const j of junk) {
      expect(() => validateCommand(j)).not.toThrow();
    }
  });
});

describe("ownership — commands cannot state authoritative outcomes", () => {
  it("rejects commands that try to eliminate a pawn", () => {
    for (const cmd of [
      { type: "eliminate", playerId: P0, pawnId: "p0" },
      { type: "eliminatePawn", playerId: P0 },
      { type: "knockout", playerId: P0 },
    ]) {
      expect(validateCommand(cmd)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects commands that try to set the phase or turn", () => {
    for (const cmd of [
      { type: "setPhase", phase: "finished" },
      { type: "nextTurn", playerId: P0 },
      { type: "skipTurn", playerId: P0 },
      { type: "settle", playerId: P0 },
    ]) {
      expect(validateCommand(cmd)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects commands that try to inject physics or win state", () => {
    for (const cmd of [
      { type: "setPosition", playerId: P0, x: 0, y: 0 },
      { type: "setVelocity", playerId: P0, x: 99, y: 99 },
      { type: "collide", playerId: P0 },
      { type: "win", playerId: P0 },
      { type: "declareWinner", playerId: P0, pawnId: "p0" },
    ]) {
      expect(validateCommand(cmd)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("the GameCommand union is exactly the three player actions plus the two match-level commands", () => {
    // Exhaustiveness canary: if a new command type is added, this literal's
    // type stops matching the union and the suite fails to compile.
    const all: GameCommand[] = [
      { type: "aim", playerId: P0, x: 0, y: 0 },
      { type: "setPower", playerId: P0, power: 1 },
      { type: "confirmLaunch", playerId: P0 },
      { type: "resolveRound" },
      { type: "reset" },
    ];
    for (const cmd of all) expect(validateCommand(cmd)).toEqual({ ok: true });
  });

  it("resolveRound is match-level: it takes no playerId", () => {
    // The wire protocol (PlayerIntent) cannot even express it — only the
    // server submits it (the room manager rejects it on the player path).
    expect(validateCommand({ type: "resolveRound" })).toEqual({ ok: true });
  });
});

describe("PlayerIntent / withPlayerId — the client bridge", () => {
  it("attaches the player identity to every owned intent", () => {
    expect(withPlayerId({ type: "aim", x: 10, y: 20 }, "p7")).toEqual({
      type: "aim",
      playerId: "p7",
      x: 10,
      y: 20,
    });
    expect(withPlayerId({ type: "setPower", power: 4 }, "p7")).toEqual({
      type: "setPower",
      playerId: "p7",
      power: 4,
    });
    expect(withPlayerId({ type: "confirmLaunch" }, "p7")).toEqual({
      type: "confirmLaunch",
      playerId: "p7",
    });
  });

  it("passes the match-level reset intent through unchanged", () => {
    expect(withPlayerId({ type: "reset" }, "p7")).toEqual({ type: "reset" });
  });

  it("produces structurally valid commands", () => {
    const intents: PlayerIntent[] = [
      { type: "aim", x: 1, y: 2 },
      { type: "setPower", power: 3 },
      { type: "confirmLaunch" },
      { type: "reset" },
    ];
    for (const intent of intents) {
      expect(validateCommand(withPlayerId(intent, P0))).toEqual({ ok: true });
    }
  });
});

describe("applyCommand — command application", () => {
  it("accepts and applies valid commands in the aiming phase", () => {
    const g = createGame();
    expect(g.applyCommand({ type: "aim", playerId: P0, x: 450, y: 400 })).toEqual({ ok: true });
    expect(g.applyCommand({ type: "setPower", playerId: P0, power: 2 })).toEqual({ ok: true });
    const view = projectSnapshot(g.getState(), P0); // the player's own view
    expect(view.aimDirection).toEqual({ x: 0, y: 1 });
    expect(view.power).toBe(2);
    expect(g.applyCommand({ type: "confirmLaunch", playerId: P0 })).toEqual({ ok: true });
    // Single pawn: the confirmation completes the set → immediate movement.
    expect(g.snapshot().phase).toBe("moving");
    g.destroy();
  });

  it("accepts reset in every phase", () => {
    const g = createGame();
    expect(g.applyCommand({ type: "reset" })).toEqual({ ok: true });
    g.applyCommand({ type: "aim", playerId: P0, x: 450, y: 40 });
    g.applyCommand({ type: "setPower", playerId: P0, power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: P0 });
    expect(g.applyCommand({ type: "reset" })).toEqual({ ok: true });
    expect(g.snapshot().phase).toBe("aiming");
    g.destroy();
  });

  it("rejects commands from a player not in the match with 'unknown-player'", () => {
    const g = createGame();
    for (const cmd of [
      { type: "aim", playerId: "p9", x: 450, y: 400 },
      { type: "setPower", playerId: "p9", power: 5 },
      { type: "confirmLaunch", playerId: "p9" },
    ] as GameCommand[]) {
      expect(g.applyCommand(cmd)).toEqual({ ok: false, reason: "unknown-player" });
    }
    g.destroy();
  });

  it("rejects an eliminated player's commands with 'wrong-player'", () => {
    // Three players; p1 is already out (two survivors keep the match
    // running) — p1's commands are rejected.
    const g = createGame({
      players: [
        { id: "p0", name: "A" },
        { id: "p1", name: "B" },
        { id: "p2", name: "C" },
      ],
    });
    const pawn = (id: string, name: string, colorIndex: number, x: number, y: number, eliminated = false) => ({
      id, name, colorIndex, radius: 16,
      spawnX: x, spawnY: y, eliminated,
      power: 3, confirmed: false,
      aim: { active: false, direction: { x: 0, y: -1 } },
      lastLaunch: null,
      position: { x, y }, velocity: { x: 0, y: 0 },
      angle: 0, angularVelocity: 0,
    });
    g.loadState({
      phase: "aiming",
      winnerId: null,
      round: { settleTicks: 0 },
      pawns: [
        pawn("p0", "A", 0, 450, 110),
        pawn("p1", "B", 1, 450, 700, true),
        pawn("p2", "C", 2, 450, 590),
      ],
    });
    for (const cmd of [
      { type: "aim", playerId: "p1", x: 450, y: 400 },
      { type: "setPower", playerId: "p1", power: 5 },
      { type: "confirmLaunch", playerId: "p1" },
    ] as GameCommand[]) {
      expect(g.applyCommand(cmd)).toEqual({ ok: false, reason: "wrong-player" });
    }
    // The alive player's commands are accepted in the SAME phase (there is
    // no turn to wait for — rounds are simultaneous).
    expect(g.applyCommand({ type: "setPower", playerId: "p0", power: 4 })).toEqual({ ok: true });
    g.destroy();
  });

  it("rejects a confirmed player's further choices with 'already-confirmed'", () => {
    const g = createGame({ players: [{ id: "p0", name: "A" }, { id: "p1", name: "B" }] });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: "p0" })).toEqual({ ok: true });
    for (const cmd of [
      { type: "aim", playerId: "p0", x: 450, y: 400 },
      { type: "setPower", playerId: "p0", power: 5 },
      { type: "confirmLaunch", playerId: "p0" },
    ] as GameCommand[]) {
      expect(g.applyCommand(cmd)).toEqual({ ok: false, reason: "already-confirmed" });
    }
    g.destroy();
  });

  it("rejects aiming/power/launch with 'wrong-phase' while moving", () => {
    const g = createGame();
    g.applyCommand({ type: "aim", playerId: P0, x: 450, y: 400 });
    g.applyCommand({ type: "confirmLaunch", playerId: P0 });
    expect(g.applyCommand({ type: "aim", playerId: P0, x: 100, y: 100 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "setPower", playerId: P0, power: 5 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: P0 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    g.destroy();
  });

  it("rejects aiming/power/launch with 'wrong-phase' once finished", () => {
    // Reason for the changed expectation: elimination is no longer a phase.
    // The single pawn flying out now ENDS the match: phase "finished",
    // winnerId null (no survivor). The old "eliminated" phase expectation is
    // intentionally replaced by the finished-match expectation.
    const g = createGame();
    g.applyCommand({ type: "setPower", playerId: P0, power: 5 });
    g.applyCommand({ type: "confirmLaunch", playerId: P0 });
    for (let i = 0; i < 200 && g.snapshot().phase === "moving"; i++) g.update(1000 / 60);
    expect(g.snapshot().phase).toBe("finished");
    expect(g.getState().winnerId).toBeNull();

    expect(g.applyCommand({ type: "aim", playerId: P0, x: 450, y: 400 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "setPower", playerId: P0, power: 1 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "confirmLaunch", playerId: P0 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    g.destroy();
  });

  it("rejects structurally invalid commands without touching state", () => {
    const g = createGame();
    const before = g.getState();
    expect(g.applyCommand({ type: "aim", x: NaN, y: 300 } as unknown as GameCommand)).toEqual({
      ok: false,
      reason: "invalid-command",
    });
    expect(
      g.applyCommand({ type: "setPhase", phase: "finished" } as unknown as GameCommand)
    ).toEqual({ ok: false, reason: "invalid-command" });
    expect(g.applyCommand(null as unknown as GameCommand)).toEqual({
      ok: false,
      reason: "invalid-command",
    });
    expect(g.getState()).toEqual(before); // nothing changed
    g.destroy();
  });

  it("dispatch remains a working legacy alias (result discarded)", () => {
    const g = createGame();
    expect(() => g.dispatch({ type: "setPower", playerId: P0, power: 4 })).not.toThrow();
    expect(projectSnapshot(g.getState(), P0).power).toBe(4);
    g.destroy();
  });
});
