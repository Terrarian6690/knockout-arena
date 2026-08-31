import type { GameState, PawnState } from "./state";
import type { GameStateSnapshot, PawnSnapshot } from "./types";

/**
 * Projection: authoritative GameState → client-facing GameStateSnapshot.
 *
 * Pure function, no engine or DOM access. This is exactly the transformation
 * a future networked client performs when it receives a state update: strip
 * reconstruction details, add presentation flags (which pawn moves, which
 * pawn is "local"). Keeping it pure means the same projection can run on a
 * server (to broadcast) or on a client (to render).
 */
export function projectSnapshot(
  state: GameState,
  localPawnId: string | null
): GameStateSnapshot {
  const activePawnId = state.turn.queue[state.turn.activeIndex] ?? null;
  const pawns: PawnSnapshot[] = state.pawns.map((p: PawnState) => ({
    id: p.id,
    position: { ...p.position },
    velocity: { ...p.velocity },
    radius: p.radius,
    eliminated: p.eliminated,
    isMoving: state.phase === "moving" && p.id === activePawnId,
    colorIndex: p.colorIndex,
  }));

  return {
    phase: state.phase,
    pawns,
    localPawnId,
    power: state.power,
    aimDirection: state.aim.active ? { ...state.aim.direction } : null,
    isAiming: state.aim.active && state.phase === "aiming",
    activePawnId,
  };
}
