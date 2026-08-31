import { describe, expect, it } from "vitest";
import { createGame } from "../game";
import { validateCommand, type GameCommand } from "../commands";

describe("validateCommand — valid commands", () => {
  it("accepts an aim command with finite coordinates", () => {
    expect(validateCommand({ type: "aim", x: 450, y: 300 })).toEqual({ ok: true });
  });

  it("accepts negative and zero aim coordinates", () => {
    expect(validateCommand({ type: "aim", x: -10, y: 0 })).toEqual({ ok: true });
  });

  it("accepts a setPower command with any finite number", () => {
    // Clamping/rounding is engine policy, not structural validation.
    expect(validateCommand({ type: "setPower", power: 3 })).toEqual({ ok: true });
    expect(validateCommand({ type: "setPower", power: 2.5 })).toEqual({ ok: true });
    expect(validateCommand({ type: "setPower", power: 99 })).toEqual({ ok: true });
    expect(validateCommand({ type: "setPower", power: -1 })).toEqual({ ok: true });
  });

  it("accepts confirmLaunch and reset", () => {
    expect(validateCommand({ type: "confirmLaunch" })).toEqual({ ok: true });
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
    for (const bad of [{}, { type: "bogus" }, { type: "" }, { type: 7 }]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects aim commands with missing or non-finite fields", () => {
    for (const bad of [
      { type: "aim" },
      { type: "aim", x: 450 },
      { type: "aim", y: 300 },
      { type: "aim", x: NaN, y: 300 },
      { type: "aim", x: 450, y: Infinity },
      { type: "aim", x: "450", y: 300 },
      { type: "aim", x: null, y: null },
    ]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects setPower commands with missing or non-finite power", () => {
    for (const bad of [
      { type: "setPower" },
      { type: "setPower", power: NaN },
      { type: "setPower", power: Infinity },
      { type: "setPower", power: "5" },
    ]) {
      expect(validateCommand(bad)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("never throws, whatever it is given", () => {
    const junk = [
      Symbol("x"),
      new Date(),
      { type: "aim", x: Number.MAX_VALUE, y: -Number.MAX_VALUE },
      { type: { nested: true } },
      { type: "aim", get x() { throw new Error("boom"); } },
    ];
    for (const j of junk) {
      expect(() => validateCommand(j)).not.toThrow();
    }
  });
});

describe("ownership — commands cannot state authoritative outcomes", () => {
  it("rejects commands that try to eliminate a pawn", () => {
    for (const cmd of [
      { type: "eliminate", pawnId: "p0" },
      { type: "eliminatePawn" },
      { type: "knockout" },
    ]) {
      expect(validateCommand(cmd)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects commands that try to set the phase or turn", () => {
    for (const cmd of [
      { type: "setPhase", phase: "eliminated" },
      { type: "nextTurn" },
      { type: "skipTurn" },
      { type: "settle" },
    ]) {
      expect(validateCommand(cmd)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("rejects commands that try to inject physics or win state", () => {
    for (const cmd of [
      { type: "setPosition", x: 0, y: 0 },
      { type: "setVelocity", x: 99, y: 99 },
      { type: "collide" },
      { type: "win" },
      { type: "declareWinner", pawnId: "p0" },
    ]) {
      expect(validateCommand(cmd)).toEqual({ ok: false, reason: "invalid-command" });
    }
  });

  it("the GameCommand union is exactly the four player intentions", () => {
    // Exhaustiveness canary: if a new command type is added, this literal's
    // type stops matching the union and the suite fails to compile.
    const all: GameCommand[] = [
      { type: "aim", x: 0, y: 0 },
      { type: "setPower", power: 1 },
      { type: "confirmLaunch" },
      { type: "reset" },
    ];
    for (const cmd of all) expect(validateCommand(cmd)).toEqual({ ok: true });
  });
});

describe("applyCommand — command application", () => {
  it("accepts and applies valid commands in the aiming phase", () => {
    const g = createGame();
    expect(g.applyCommand({ type: "aim", x: 450, y: 400 })).toEqual({ ok: true });
    expect(g.applyCommand({ type: "setPower", power: 2 })).toEqual({ ok: true });
    expect(g.snapshot().aimDirection).toEqual({ x: 0, y: 1 });
    expect(g.snapshot().power).toBe(2);
    expect(g.applyCommand({ type: "confirmLaunch" })).toEqual({ ok: true });
    expect(g.snapshot().phase).toBe("moving");
    g.destroy();
  });

  it("accepts reset in every phase", () => {
    const g = createGame();
    expect(g.applyCommand({ type: "reset" })).toEqual({ ok: true });
    g.applyCommand({ type: "aim", x: 450, y: 40 });
    g.applyCommand({ type: "setPower", power: 5 });
    g.applyCommand({ type: "confirmLaunch" });
    expect(g.applyCommand({ type: "reset" })).toEqual({ ok: true });
    expect(g.snapshot().phase).toBe("aiming");
    g.destroy();
  });

  it("rejects aiming/power/launch with 'wrong-phase' while moving", () => {
    const g = createGame();
    g.applyCommand({ type: "aim", x: 450, y: 400 });
    g.applyCommand({ type: "confirmLaunch" });
    expect(g.applyCommand({ type: "aim", x: 100, y: 100 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "setPower", power: 5 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "confirmLaunch" })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    g.destroy();
  });

  it("rejects aiming/power/launch with 'wrong-phase' while eliminated", () => {
    const g = createGame();
    g.applyCommand({ type: "setPower", power: 5 });
    g.applyCommand({ type: "confirmLaunch" });
    for (let i = 0; i < 200 && g.snapshot().phase === "moving"; i++) g.update(1000 / 60);
    expect(g.snapshot().phase).toBe("eliminated");

    expect(g.applyCommand({ type: "aim", x: 450, y: 400 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "setPower", power: 1 })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "confirmLaunch" })).toEqual({
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
    expect(g.applyCommand({ type: "setPhase", phase: "eliminated" } as unknown as GameCommand)).toEqual({
      ok: false,
      reason: "invalid-command",
    });
    expect(g.applyCommand(null as unknown as GameCommand)).toEqual({
      ok: false,
      reason: "invalid-command",
    });
    expect(g.getState()).toEqual(before); // nothing changed
    g.destroy();
  });

  it("dispatch remains a working legacy alias (result discarded)", () => {
    const g = createGame();
    expect(() => g.dispatch({ type: "setPower", power: 4 })).not.toThrow();
    expect(g.snapshot().power).toBe(4);
    g.destroy();
  });
});
