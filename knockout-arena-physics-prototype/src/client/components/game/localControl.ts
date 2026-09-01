import type { GameStateSnapshot } from "../../../game";

/**
 * May the LOCAL player send gameplay commands right now?
 *
 * Pure function over the AUTHORITATIVE snapshot — every condition comes
 * from the server's data:
 *   - the match is in the aiming phase,
 *   - this viewer has a pawn (snapshot.localPawnId, the server's own
 *     viewer projection — never computed from roster position),
 *   - it is that pawn's turn (snapshot.activePawnId),
 *   - and that pawn is still alive.
 *
 * This is an INPUT gate only: it decides whether to send an intent, never
 * whether the intent succeeds — that remains the server's call, and any
 * rejection comes back as an error to display.
 */
export function canLocalPlayerAct(snapshot: GameStateSnapshot | null): boolean {
  if (snapshot === null) return false;
  if (snapshot.phase !== "aiming") return false;
  const localPawnId = snapshot.localPawnId;
  if (localPawnId === null) return false;
  if (snapshot.activePawnId !== localPawnId) return false;
  const localPawn = snapshot.pawns.find((pawn) => pawn.id === localPawnId);
  return localPawn !== undefined && !localPawn.eliminated;
}
