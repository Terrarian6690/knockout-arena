import { CONFIG } from "./config";
import type { GameState, PawnState } from "./state";
import type { GameStateSnapshot, PawnSnapshot } from "./types";

/**
 * Projection: authoritative GameState → client-facing GameStateSnapshot.
 *
 * Pure function, no engine or DOM access. This is exactly the transformation
 * a networked client performs when it receives a state update: strip
 * reconstruction details, add presentation flags (which pawn is "local").
 *
 * Rounds are simultaneous — there is no active pawn. The control fields
 * (power, aimDirection, isAiming) therefore describe THE VIEWER'S OWN pawn
 * (the projection target): each player sees their own current-round
 * selection. A spectator projection (localPawnId null) has no pawn to
 * describe and reports the neutral defaults.
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
  const localPawn = localPawnId
    ? state.pawns.find((p) => p.id === localPawnId) ?? null
    : null;
  const pawns: PawnSnapshot[] = state.pawns.map((p: PawnState) => ({
    id: p.id,
    name: p.name,
    position: { ...p.position },
    velocity: { ...p.velocity },
    radius: p.radius,
    eliminated: p.eliminated,
    /** Locked in for the current round (aiming phase only). */
    confirmed: p.confirmed,
    isLocal: p.id === localPawnId,
    colorIndex: p.colorIndex,
  }));

  return {
    phase: state.phase,
    pawns,
    localPawnId,
    winnerId: state.winnerId,
    // The controls shown by the UI are the VIEWER'S OWN selections — each
    // player's aim/power/confirmed live on their pawn in the authoritative
    // state, and everyone chooses simultaneously.
    power: localPawn ? localPawn.power : CONFIG.power.default,
    aimDirection:
      localPawn && localPawn.aim.active
        ? { ...localPawn.aim.direction }
        : null,
    isAiming:
      state.phase === "aiming" &&
      localPawn !== null &&
      localPawn.aim.active &&
      !localPawn.eliminated,
  };
}
