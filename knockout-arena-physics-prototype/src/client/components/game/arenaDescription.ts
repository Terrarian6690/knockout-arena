import { CONFIG, type GameStateSnapshot, type PawnSnapshot } from "../../../game";

/**
 * Textual description of the PUBLIC arena state (Task 12, first pass).
 *
 * The canvas is the only place several facts exist — who is still in,
 * who is still deciding, how far the arena has closed in. This module
 * turns the authoritative snapshot into a sentence a screen reader can
 * read on demand.
 *
 * STATE, NOT EVENTS. Tasks 9 and 10 own the event-driven live regions
 * (a result was decided; someone was knocked out; a round began). This
 * is the opposite kind of thing: a standing answer to "what does the
 * board look like right now", carrying no live-region semantics, so it
 * never competes with those announcements. The distinction is why the
 * text deliberately reads as a status list rather than a narrative.
 *
 * PUBLIC DATA ONLY. Exactly like the Task 10 builders, every pawn is
 * narrowed to an allowlist before any sentence is built, so private
 * aim direction and power cannot reach the output even by accident:
 * they are not present on the objects the writers can see.
 */

/**
 * The only pawn fields any description sentence may read. `confirmed`
 * is public by design (the wire protocol documents readiness as
 * everyone's business — it reveals nothing about direction or power);
 * `launch` is deliberately absent even though the server reveals it
 * while a round resolves, because this summary never narrates moves.
 */
export const DESCRIPTION_PAWN_FIELDS = [
  "id",
  "name",
  "eliminated",
  "confirmed",
  "isLocal",
] as const;

/** A pawn reduced to the public fields the description may mention. */
export interface DescribedPawn {
  readonly id: string;
  readonly name: string;
  readonly eliminated: boolean;
  readonly confirmed: boolean;
  readonly isLocal: boolean;
}

/** Copy a pawn down to the allowlist. Private fields are dropped here. */
export function describedPawn(pawn: PawnSnapshot): DescribedPawn {
  return {
    id: pawn.id,
    name: pawn.name,
    eliminated: pawn.eliminated,
    confirmed: pawn.confirmed,
    isLocal: pawn.isLocal,
  };
}

/**
 * Qualitative arena size. Screen reader users get no value from "radius
 * 250" — what matters is how much room is left and whether it can still
 * get worse. Tiers are derived from the authoritative shrink schedule
 * (initial radius, step, minimum), never hard-coded, so they stay
 * correct if the configuration changes.
 */
export const ARENA_SIZE_LABELS = {
  full: "full size",
  shrunkOnce: "shrunk once",
  shrunkTwice: "shrunk twice",
  shrunk: "shrunk", // 3+ steps, still above the minimum: "shrunk 3 times"
  minimum: "minimum size",
} as const;

/**
 * How many shrink steps the arena is below its starting radius, and
 * whether it has bottomed out. Derived from the same CONFIG the server
 * schedules shrinks from.
 */
export function arenaSizeLabel(radius: number | undefined): string {
  const { radius: initial, shrink } = CONFIG.arena;
  if (radius === undefined || !Number.isFinite(radius)) {
    return ARENA_SIZE_LABELS.full;
  }
  if (radius <= shrink.minRadius) return ARENA_SIZE_LABELS.minimum;
  if (radius >= initial) return ARENA_SIZE_LABELS.full;

  const steps = Math.round((initial - radius) / shrink.amount);
  if (steps <= 0) return ARENA_SIZE_LABELS.full;
  if (steps === 1) return ARENA_SIZE_LABELS.shrunkOnce;
  if (steps === 2) return ARENA_SIZE_LABELS.shrunkTwice;
  return `${ARENA_SIZE_LABELS.shrunk} ${steps} times`;
}

/**
 * The phase sentence. Rounds are SIMULTANEOUS — there is no "whose
 * turn" — so this describes the decision phase and, while players are
 * still choosing, how many have locked in.
 */
export function phaseDescription(
  phase: GameStateSnapshot["phase"],
  pawns: readonly DescribedPawn[]
): string {
  if (phase === "finished") return "The match is over.";
  if (phase === "moving") return "The round is resolving.";

  const alive = pawns.filter((p) => !p.eliminated);
  const waiting = alive.filter((p) => !p.confirmed);
  if (alive.length === 0) return "Players are choosing their moves.";
  if (waiting.length === 0) {
    return "All players are ready; the round is about to resolve.";
  }
  const you = waiting.find((p) => p.isLocal) !== undefined;
  const others = waiting.length - (you ? 1 : 0);
  if (you && others === 0) return "Players are choosing their moves. It is your move.";
  if (you) {
    return `Players are choosing their moves. It is your move, and ${others} other ${others === 1 ? "player is" : "players are"} still deciding.`;
  }
  return `Players are choosing their moves. Waiting for ${waiting.length} ${waiting.length === 1 ? "player" : "players"}.`;
}

/** One seat's clause: name, who it is, and whether they are still in. */
export function seatDescription(
  pawn: DescribedPawn,
  hostPlayerId: string | null
): string {
  const tags: string[] = [];
  if (pawn.isLocal) tags.push("you");
  if (pawn.id === hostPlayerId) tags.push("host");
  const who = tags.length > 0 ? `${pawn.name} (${tags.join(", ")})` : pawn.name;
  return `${who}: ${pawn.eliminated ? "knocked out" : "still in"}`;
}

/** An unoccupied seat on the six-seat roster. */
function emptySeatDescription(index: number): string {
  return `Seat ${index + 1}: empty`;
}

export interface DescriptionInput {
  readonly snapshot: GameStateSnapshot | null;
  readonly hostPlayerId: string | null;
}

/**
 * The whole description. Ordered so the most useful facts come first
 * for someone listening linearly: round, then how much room is left,
 * then the phase, then the roster.
 *
 * Seats are reported against the room's full capacity, so "empty" seats
 * are visible rather than silently missing.
 */
export function describeArenaState({
  snapshot,
  hostPlayerId,
}: DescriptionInput): string {
  if (snapshot === null) return "Waiting for the match to start.";

  const pawns = snapshot.pawns.map(describedPawn);
  const parts: string[] = [];

  if (snapshot.roundNumber !== undefined) {
    parts.push(`Round ${snapshot.roundNumber}.`);
  }
  parts.push(`Arena ${arenaSizeLabel(snapshot.arena?.radius)}.`);
  parts.push(phaseDescription(snapshot.phase, pawns));

  const alive = pawns.filter((p) => !p.eliminated).length;
  parts.push(
    `${alive} of ${pawns.length} ${pawns.length === 1 ? "player" : "players"} still in.`
  );

  const seats: string[] = pawns.map((p) => seatDescription(p, hostPlayerId));
  for (let i = pawns.length; i < CONFIG.match.maxPlayers; i += 1) {
    seats.push(emptySeatDescription(i));
  }
  parts.push(`Seats: ${seats.join("; ")}.`);

  return parts.join(" ");
}

/**
 * The subset of the snapshot the description actually depends on.
 *
 * The description must be rebuilt when the public state changes, and
 * NOT on every snapshot push — pawns move, aim previews update and the
 * server streams frames continuously, none of which changes a word of
 * the text. Comparing this key instead of the snapshot object keeps the
 * DOM untouched through those ticks (see ArenaStateDescription).
 *
 * Deliberately EXCLUDED: positions, velocities, aim direction, power,
 * launches, deadlines — movement and private choices.
 */
export function descriptionKey({
  snapshot,
  hostPlayerId,
}: DescriptionInput): string {
  if (snapshot === null) return "none";
  const seats = snapshot.pawns
    .map(
      (p) =>
        `${p.id}:${p.name}:${p.eliminated ? "1" : "0"}:${p.confirmed ? "1" : "0"}:${p.isLocal ? "1" : "0"}`
    )
    .join("|");
  return [
    snapshot.phase,
    snapshot.roundNumber ?? "-",
    // The qualitative TIER, not the radius: an interpolated or
    // in-between radius that lands in the same tier says the same thing.
    arenaSizeLabel(snapshot.arena?.radius),
    hostPlayerId ?? "-",
    seats,
  ].join("~");
}
