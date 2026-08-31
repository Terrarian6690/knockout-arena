import { CONFIG } from "./config";
import type { GamePhase } from "./types";

/**
 * Turn logic state machine.
 *
 * In phase 1 this is trivial (a single pawn that aims → launches → settles),
 * but the structure is designed to grow into a full multiplayer turn order:
 *  - a queue of participant ids
 *  - simultaneous-turn flags (all players aim, then all resolve)
 *  - bot participants that select a target + power procedurally
 *
 * Keeping the phase transitions here (rather than in game.ts) means the
 * multiplayer ruleset can evolve independently of physics/rendering.
 */
export type TurnPhase = Extract<GamePhase, "aiming" | "moving" | "gameOver">;

export interface TurnState {
  phase: TurnPhase;
  /** Pawn ids in turn order. Single-player uses ["p0"]. */
  queue: string[];
  /** Index of the currently acting pawn in the queue. */
  activeIndex: number;
  /** Ticks elapsed since the active pawn was launched. */
  settleTicks: number;
  /** Whether any pawn is still in motion. */
  moving: boolean;
}

export function createTurnState(pawnIds: string[]): TurnState {
  return {
    phase: pawnIds.length ? "aiming" : "gameOver",
    queue: pawnIds,
    activeIndex: 0,
    settleTicks: 0,
    moving: false,
  };
}

export function activePawnId(turn: TurnState): string | null {
  return turn.queue[turn.activeIndex] ?? null;
}

/** Advance to the next actor. Returns true if we wrapped around. */
export function advanceTurn(turn: TurnState): boolean {
  turn.activeIndex = (turn.activeIndex + 1) % turn.queue.length;
  turn.settleTicks = 0;
  return turn.activeIndex === 0;
}

export interface SettleResult {
  settled: boolean;
  timedOut: boolean;
}

/**
 * Decide whether the moving pawn has settled. A pawn "settles" when its speed
 * drops below a threshold; we also cap the wait time to avoid soft-locks.
 */
export function checkSettled(
  speed: number,
  settleTicks: number
): SettleResult {
  const timedOut = settleTicks >= CONFIG.simulation.maxSettleTicks;
  const settled = speed < CONFIG.simulation.restSpeedThreshold;
  return { settled: settled || timedOut, timedOut };
}
