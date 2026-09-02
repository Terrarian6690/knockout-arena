import { CONFIG } from "./config";
import type { GamePhase } from "./types";

/**
 * Round logic state machine — the single source of truth for the game phase.
 *
 * SIMULTANEOUS ROUNDS: there is no turn queue and no "current player".
 * Every round is one shared decision phase in which ALL alive players
 * choose independently (aim, power, confirm); when every alive player has
 * confirmed — or the server forces the round to resolve (its decision
 * deadline, see the `resolveRound` command) — all confirmed movements
 * start together in one simulation transition and physics resolves them
 * simultaneously. Unconfirmed players simply do not move that round.
 *
 * The phase lives on `RoundState` and every other module (game.ts,
 * renderer, UI) reads it from here; nothing keeps a duplicate copy.
 * Keeping the phase + round bookkeeping here (rather than in game.ts)
 * means the multiplayer ruleset can evolve independently of
 * physics/rendering.
 */
export interface RoundState {
  /** Current phase. game.ts transitions it; everything else reads it. */
  phase: GamePhase;
  /** Fixed simulation ticks elapsed since the round's movements started. */
  settleTicks: number;
}

export function createRoundState(): RoundState {
  return {
    phase: "aiming",
    settleTicks: 0,
  };
}

export interface SettleResult {
  settled: boolean;
  timedOut: boolean;
}

/**
 * Decide whether the moving phase has settled. The round resolves when
 * EVERY alive pawn has come to rest (shoved opponents included); we also
 * cap the wait (counted in fixed simulation ticks, so it is independent
 * of display frame rate) to avoid soft-locks.
 */
export function checkSettled(
  speed: number,
  settleTicks: number
): SettleResult {
  const timedOut = settleTicks >= CONFIG.simulation.maxSettleTicks;
  const settled = speed < CONFIG.simulation.restSpeedThreshold;
  return { settled: settled || timedOut, timedOut };
}
