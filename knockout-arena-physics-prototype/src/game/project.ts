import { CONFIG } from "./config";
import type { GameState, PawnState } from "./state";
import type { GameStateSnapshot, PawnSnapshot } from "./types";

/**
 * Projection: authoritative GameState → client-facing GameStateSnapshot.
 *
 * Pure function, no engine or DOM access. This is exactly the transformation
 * a future networked client performs when it receives a state update: strip
 * reconstruction details, add presentation flags (which pawn moves, which
 * pawn is "local").
 *
 * The local perspective is supplied BY THE CALLER: the engine has no notion
 * of a local player, so a server broadcasting to spectators passes null and
 * each client passes its own pawn id. The same authoritative state projects
 * differently per viewer without ever being mutated.
 */
export function projectSnapshot(
  state: GameState,
  localPawnId: string | null
): GameStateSnapshot {
  const activePawnId = state.turn.queue[state.turn.activeIndex] ?? null;
  const activePawn = activePawnId
    ? state.pawns.find((p) => p.id === activePawnId) ?? null
    : null;
  const pawns: PawnSnapshot[] = state.pawns.map((p: PawnState) => ({
    id: p.id,
    name: p.name,
    position: { ...p.position },
    velocity: { ...p.velocity },
    radius: p.radius,
    eliminated: p.eliminated,
    isMoving: state.phase === "moving" && p.id === activePawnId,
    isLocal: p.id === localPawnId,
    colorIndex: p.colorIndex,
  }));

  return {
    phase: state.phase,
    pawns,
    localPawnId,
    winnerId: state.winnerId,
    // Controls shown by the UI are the ACTIVE pawn's selections — each
    // player's own aim/power live on their pawn in the authoritative state.
    power: activePawn ? activePawn.power : CONFIG.power.default,
    aimDirection:
      activePawn && activePawn.aim.active
        ? { ...activePawn.aim.direction }
        : null,
    isAiming:
      state.phase === "aiming" && activePawn !== null && activePawn.aim.active,
    activePawnId,
  };
}
