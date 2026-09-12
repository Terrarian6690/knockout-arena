import { describe, expect, it } from "vitest";
import {
  CONFIG,
  createGame,
  deserializeGameState,
  projectSnapshot,
  serializeGameState,
  type GameHandle,
  type GameState,
} from "../index";

/**
 * THE AUTHORITATIVE ROUND ORDINAL (Task 10).
 *
 * `round.number` is not a new mechanism: it is the engine's existing
 * completed-round event — the one that already drives the shrink
 * schedule — counted without the every-3 reset so it can be spoken as an
 * ordinal ("Round 4 begins").
 *
 * The property that matters is LOCKSTEP: the ordinal and the shrink
 * cadence must be two views of the same event. If a future change makes
 * a round complete without advancing the schedule (or vice versa), these
 * tests fail rather than letting the announcement drift from reality.
 *
 * It must also stay INFORMATIONAL: nothing authoritative may branch on
 * it, and a hand-fed value must not be able to bend the schedule.
 */

const DT = 1000 / 60;
const EVERY = CONFIG.arena.shrink.everyRounds;

function twoPlayerGame(): GameHandle {
  return createGame({
    players: [
      { id: "p0", name: "Player 1" },
      { id: "p1", name: "Player 2" },
    ],
  });
}

/** Complete one round without anyone launching. */
function playEmptyRound(game: GameHandle): void {
  game.applyCommand({ type: "resolveRound" });
  let guard = 0;
  while (game.getState().phase === "moving" && guard++ < 5_000) game.update(DT);
}

const roundOf = (game: GameHandle): number | undefined =>
  game.getState().round.number;

describe("the round ordinal counts completed rounds", () => {
  it("starts at round 1", () => {
    expect(roundOf(twoPlayerGame())).toBe(1);
  });

  it("advances by exactly one per completed round", () => {
    const game = twoPlayerGame();
    for (let expected = 2; expected <= 5; expected++) {
      playEmptyRound(game);
      expect(roundOf(game)).toBe(expected);
    }
  });

  it("does not advance mid-round (only on completion)", () => {
    const game = twoPlayerGame();
    expect(roundOf(game)).toBe(1);
    // Commands and ticks inside a round change nothing.
    game.applyCommand({ type: "aim", playerId: "p0", x: 500, y: 400 });
    game.applyCommand({ type: "setPower", playerId: "p0", power: 2 });
    game.update(DT);
    game.update(DT);
    expect(roundOf(game)).toBe(1);
    // Starting the movement phase is not yet a COMPLETED round.
    game.applyCommand({ type: "resolveRound" });
    expect(roundOf(game)).toBe(1);
    // Settling completes it.
    let guard = 0;
    while (game.getState().phase === "moving" && guard++ < 5_000) game.update(DT);
    expect(roundOf(game)).toBe(2);
  });

  it("resets to 1 for a fresh match", () => {
    const game = twoPlayerGame();
    playEmptyRound(game);
    playEmptyRound(game);
    expect(roundOf(game)).toBe(3);
    game.applyCommand({ type: "reset" });
    expect(roundOf(game)).toBe(1);
  });
});

describe("the ordinal is in LOCKSTEP with the shrink cadence", () => {
  it("moves on exactly the same event as roundsSinceShrink", () => {
    const game = twoPlayerGame();
    // Both counters derive from one completed-round event, so the
    // ordinal is fully determined by the cycle position at every step.
    // Idle pawns are eventually eliminated by the shrinking arena, so
    // walk only while the match is genuinely still running.
    let rounds = 0;
    for (let round = 1; round <= EVERY * 3; round++) {
      const state = game.getState();
      if (state.phase === "finished") break;
      expect(state.round.number).toBe(round);
      expect(state.arena!.roundsSinceShrink).toBe((round - 1) % EVERY);
      playEmptyRound(game);
      rounds++;
    }
    // The walk has to have covered at least one full shrink cycle for
    // this to prove anything.
    expect(rounds).toBeGreaterThan(EVERY);
  });

  it("shrinks exactly when the ordinal crosses a multiple of the interval", () => {
    const game = twoPlayerGame();
    const initial = game.getState().arena!.radius;
    // Rounds 1..EVERY are played at the initial radius…
    for (let i = 0; i < EVERY; i++) {
      expect(game.getState().arena!.radius).toBe(initial);
      playEmptyRound(game);
    }
    // …and the shrink lands together with the ordinal reaching EVERY+1.
    expect(game.getState().round.number).toBe(EVERY + 1);
    expect(game.getState().arena!.radius).toBeLessThan(initial);
  });

  it("lets a client derive the countdown it is already shown", () => {
    // The projected roundsUntilShrink must agree with the ordinal's
    // position in the cycle — the same truth, two presentations.
    const game = twoPlayerGame();
    for (let i = 0; i < EVERY * 2; i++) {
      const snapshot = projectSnapshot(game.getState(), "p0");
      const untilShrink = snapshot.arena!.roundsUntilShrink;
      if (untilShrink !== null) {
        const cyclePosition = (snapshot.roundNumber! - 1) % EVERY;
        expect(untilShrink).toBe(EVERY - cyclePosition);
      }
      playEmptyRound(game);
    }
  });
});

describe("the ordinal travels with the authoritative state", () => {
  it("survives a serialize → deserialize round trip", () => {
    const game = twoPlayerGame();
    playEmptyRound(game);
    playEmptyRound(game);
    const wire = serializeGameState(game.getState());
    expect(deserializeGameState(wire).round.number).toBe(3);
  });

  it("is restored by loadState (a reconnect keeps counting correctly)", () => {
    const source = twoPlayerGame();
    playEmptyRound(source);
    playEmptyRound(source);
    playEmptyRound(source);
    const saved = source.getState();

    const restored = twoPlayerGame();
    restored.loadState(deserializeGameState(serializeGameState(saved)));
    expect(restored.getState().round.number).toBe(saved.round.number);
    // …and it keeps advancing from there, still in lockstep.
    playEmptyRound(restored);
    expect(restored.getState().round.number).toBe(saved.round.number! + 1);
    expect(restored.getState().arena!.roundsSinceShrink).toBe(
      saved.arena!.roundsSinceShrink + 1 === EVERY
        ? 0
        : saved.arena!.roundsSinceShrink + 1
    );
  });

  it("accepts a state from BEFORE the field existed (resumes at 1)", () => {
    const game = twoPlayerGame();
    playEmptyRound(game);
    const legacy = JSON.parse(serializeGameState(game.getState())) as GameState;
    delete (legacy.round as { number?: number }).number;

    const rebuilt = twoPlayerGame();
    rebuilt.loadState(deserializeGameState(JSON.stringify(legacy)));
    expect(rebuilt.getState().round.number).toBe(1);
  });

  it("rejects a malformed ordinal", () => {
    const game = twoPlayerGame();
    const state = JSON.parse(serializeGameState(game.getState())) as GameState;
    for (const bad of [0, -3, 1.5, "4", null]) {
      const corrupt = {
        ...state,
        round: { ...state.round, number: bad },
      };
      expect(() => deserializeGameState(JSON.stringify(corrupt))).toThrow(
        /round\.number/
      );
    }
  });
});

describe("the ordinal is INFORMATIONAL only", () => {
  it("cannot bend the shrink schedule when hand-fed", () => {
    // A forged ordinal far past a shrink boundary must not shrink the
    // arena: the schedule reads roundsSinceShrink, never this value.
    const game = twoPlayerGame();
    const state = JSON.parse(serializeGameState(game.getState())) as GameState;
    const initialRadius = state.arena!.radius;
    state.round.number = 999;
    state.arena!.roundsSinceShrink = 0;

    const target = twoPlayerGame();
    target.loadState(deserializeGameState(JSON.stringify(state)));
    expect(target.getState().arena!.radius).toBe(initialRadius);
    // Two more empty rounds still are not enough to trigger a shrink…
    playEmptyRound(target);
    playEmptyRound(target);
    expect(target.getState().arena!.radius).toBe(initialRadius);
    // …the third one is, exactly as the real schedule dictates.
    playEmptyRound(target);
    expect(target.getState().arena!.radius).toBeLessThan(initialRadius);
  });

  it("does not affect elimination or the winner", () => {
    const game = twoPlayerGame();
    const state = JSON.parse(serializeGameState(game.getState())) as GameState;
    state.round.number = 500;
    game.loadState(deserializeGameState(JSON.stringify(state)));
    // A high ordinal ends nothing by itself.
    expect(game.getState().phase).toBe("aiming");
    expect(game.getState().winnerId).toBeNull();
    expect(game.getState().pawns.every((p) => !p.eliminated)).toBe(true);
  });
});

describe("the projected snapshot carries the ordinal", () => {
  it("exposes roundNumber to clients", () => {
    const game = twoPlayerGame();
    expect(projectSnapshot(game.getState(), "p0").roundNumber).toBe(1);
    playEmptyRound(game);
    expect(projectSnapshot(game.getState(), "p0").roundNumber).toBe(2);
  });

  it("shows every viewer the SAME round (it is not per-player)", () => {
    const game = twoPlayerGame();
    playEmptyRound(game);
    const a = projectSnapshot(game.getState(), "p0");
    const b = projectSnapshot(game.getState(), "p1");
    const spectator = projectSnapshot(game.getState(), null);
    expect(a.roundNumber).toBe(2);
    expect(b.roundNumber).toBe(2);
    expect(spectator.roundNumber).toBe(2);
  });

  it("defaults a hand-built state with no ordinal to round 1", () => {
    const game = twoPlayerGame();
    const state = game.getState();
    delete (state.round as { number?: number }).number;
    expect(projectSnapshot(state, "p0").roundNumber).toBe(1);
  });
});
