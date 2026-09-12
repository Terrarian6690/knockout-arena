import { arenaFromSnapshot, type GameStateSnapshot } from "../../../game";

/**
 * Sentence builders for the mid-match accessible announcements (Task 10):
 * who was knocked out, and when a new round begins.
 *
 * Pure functions over two consecutive AUTHORITATIVE snapshots. They
 * decide nothing: every fact spoken here is already public in the
 * snapshot the server sent (a pawn's `eliminated` flag, its display
 * name, the server's own `roundNumber`, the authoritative arena radius).
 * Nothing is predicted, counted or inferred locally — if the server did
 * not say it, it is not announced.
 *
 * PRIVACY: the only per-pawn fields ever read are `id`, `name` and
 * `eliminated`. Aim direction, power, confirmation/readiness and launch
 * data are never touched, so no announcement can leak a rival's choice.
 * The `announcementReadsOnlyPublicFields` allowlist below is asserted by
 * the tests, so widening it is a deliberate, visible act.
 */

/** The ONLY pawn fields any announcement may read. */
export const ANNOUNCEMENT_PAWN_FIELDS = ["id", "name", "eliminated"] as const;

/** Public shape of one pawn, as far as announcements are concerned. */
type AnnouncedPawn = Pick<
  GameStateSnapshot["pawns"][number],
  "id" | "name" | "eliminated"
>;

/**
 * Seat id → the label the rest of the UI already shows ("p2" → "Player
 * 3"), used only if a pawn somehow carries no name.
 */
function seatLabel(playerId: string): string {
  const match = /^p(\d+)$/.exec(playerId);
  return match === null ? playerId : `Player ${Number(match[1]) + 1}`;
}

function displayName(pawn: AnnouncedPawn): string {
  return pawn.name.trim() === "" ? seatLabel(pawn.id) : pawn.name;
}

/**
 * Who newly became eliminated between `prev` and `next`.
 *
 * Roster order (the snapshot's own pawn order, p0 first) — so a round
 * that knocks out several players at once reads in a stable, predictable
 * sequence rather than whatever order the physics happened to resolve.
 */
export function newlyEliminated(
  prev: Pick<GameStateSnapshot, "pawns"> | null,
  next: Pick<GameStateSnapshot, "pawns">
): AnnouncedPawn[] {
  if (prev === null) return []; // first snapshot: no transition to report
  const wasEliminated = new Map<string, boolean>();
  for (const pawn of prev.pawns) wasEliminated.set(pawn.id, pawn.eliminated);
  return next.pawns
    .filter((pawn) => pawn.eliminated && wasEliminated.get(pawn.id) === false)
    .map((pawn) => ({ id: pawn.id, name: pawn.name, eliminated: pawn.eliminated }));
}

/**
 * The elimination sentence, or "" when nobody newly went out.
 *
 * ALL eliminations from one resolution are reported in a single string,
 * so simultaneous knockouts produce ONE announcement rather than a burst
 * of competing ones. The viewer's own elimination is phrased in the
 * second person — it is the one a player most needs to notice.
 */
export function eliminationAnnouncement(
  prev: Pick<GameStateSnapshot, "pawns"> | null,
  next: Pick<GameStateSnapshot, "pawns">,
  localPawnId: string | null
): string {
  const out = newlyEliminated(prev, next);
  if (out.length === 0) return "";

  const you = out.filter((pawn) => pawn.id === localPawnId);
  const others = out.filter((pawn) => pawn.id !== localPawnId);
  const parts: string[] = [];

  if (you.length > 0) parts.push("You were knocked out.");
  if (others.length === 1) {
    parts.push(`${displayName(others[0])} was knocked out.`);
  } else if (others.length > 1) {
    const names = others.map(displayName);
    const last = names.pop() as string;
    parts.push(`${names.join(", ")} and ${last} were knocked out.`);
  }
  return parts.join(" ");
}

/**
 * The round-transition sentence, or "" when no new round began.
 *
 * Driven by the server's own `roundNumber`: a new round is announced
 * only when that authoritative ordinal actually advances. The shrink
 * note is added only when the authoritative radius genuinely decreased
 * across the same transition — it reports an observable fact ("smaller
 * now"), never the schedule's internals (no step size, no countdown).
 */
export function roundAnnouncement(
  prev: GameStateSnapshot | null,
  next: GameStateSnapshot
): string {
  if (prev === null) return ""; // first snapshot: nothing to transition from
  // A finished match is the result overlay's business, not a new round.
  if (next.phase === "finished") return "";

  const before = prev.roundNumber;
  const now = next.roundNumber;
  if (typeof before !== "number" || typeof now !== "number") return "";
  if (now <= before) return "";

  const shrank = arenaFromSnapshot(next).radius < arenaFromSnapshot(prev).radius;
  return shrank
    ? `Round ${now} begins. The arena has shrunk.`
    : `Round ${now} begins.`;
}

/**
 * The complete mid-match announcement for one authoritative transition:
 * eliminations first (what just happened), then the new round (what
 * happens next). Empty when the transition is not worth speaking.
 */
export function matchProgressAnnouncement(
  prev: GameStateSnapshot | null,
  next: GameStateSnapshot
): string {
  return [
    eliminationAnnouncement(prev, next, next.localPawnId),
    roundAnnouncement(prev, next),
  ]
    .filter((part) => part !== "")
    .join(" ");
}
