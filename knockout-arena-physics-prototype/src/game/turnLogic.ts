import { CONFIG } from "./config";
import type { GamePhase } from "./types";

/**
 * Turn logic state machine — the single source of truth for the game phase.
 *
 * The phase lives on `TurnState` and every other module (game.ts, renderer,
 * UI) reads it from here; nothing keeps a duplicate copy.
 *
 * The queue holds the FULL roster in stable turn order for the whole match
 * (replay-friendly, indices never shift). Rotation skips eliminated pawns at
 * runtime via the isEliminated predicate, so who acts next is a pure function
 * of (queue, activeIndex, eliminated flags) — deterministic and identical on
 * any host that loads the same state.
 *
 * Keeping phase + turn order here (rather than in game.ts) means the
 * multiplayer ruleset can evolve independently of physics/rendering.
 */
export type TurnPhase = GamePhase;

export interface TurnState {
  /** Current phase. game.ts transitions it; everything else reads it. */
  phase: TurnPhase;
  /** ALL pawn ids in turn order (including eliminated pawns). */
  queue: string[];
  /** Index of the currently acting pawn in the queue. */
  activeIndex: number;
  /** Fixed simulation ticks elapsed since the active pawn launched. */
  settleTicks: number;
}

export function createTurnState(pawnIds: string[]): TurnState {
  return {
    phase: "aiming",
    queue: pawnIds,
    activeIndex: 0,
    settleTicks: 0,
  };
}

export function activePawnId(turn: TurnState): string | null {
  return turn.queue[turn.activeIndex] ?? null;
}

/**
 * Advance to the next pawn that is still in the match, skipping eliminated
 * pawns deterministically (stable queue order, wrap-around). Returns the new
 * active pawn id, or null when every pawn is eliminated.
 *
 * Note: the pawn at the CURRENT activeIndex is never re-selected by this
 * function while any other pawn is active — even after wrapping, rotation
 * always moves at least one seat forward.
 */
export function advanceTurn(
  turn: TurnState,
  isEliminated: (pawnId: string) => boolean
): string | null {
  const n = turn.queue.length;
  for (let step = 1; step <= n; step++) {
    const index = (turn.activeIndex + step) % n;
    const id = turn.queue[index];
    if (!isEliminated(id)) {
      turn.activeIndex = index;
      turn.settleTicks = 0;
      return id;
    }
  }
  return null; // every pawn in the queue is eliminated
}

export interface SettleResult {
  settled: boolean;
  timedOut: boolean;
}

/**
 * Decide whether the moving pawn has settled. A pawn "settles" when its speed
 * drops below a threshold; we also cap the wait (counted in fixed simulation
 * ticks, so it is independent of display frame rate) to avoid soft-locks.
 */
export function checkSettled(
  speed: number,
  settleTicks: number
): SettleResult {
  const timedOut = settleTicks >= CONFIG.simulation.maxSettleTicks;
  const settled = speed < CONFIG.simulation.restSpeedThreshold;
  return { settled: settled || timedOut, timedOut };
}
