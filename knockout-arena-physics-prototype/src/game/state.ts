import { CONFIG } from "./config";
import type { GamePhase, Vec2 } from "./types";

/**
 * The serializable, authoritative game state.
 *
 * GameState contains EVERYTHING needed to reconstruct a match inside a fresh
 * engine instance — no Matter.js internals, no functions, no object
 * references, only plain JSON data:
 *
 *   - the phase machine (phase, winner, round settle ticks)
 *   - per-pawn domain state (identity, colors, spawn, elimination flag)
 *   - per-pawn round selections (aim, power, and whether the player has
 *     confirmed their move for the CURRENT round)
 *   - per-pawn committed launches (the reveal data for the round being
 *     resolved — public once movements begin, private before)
 *   - per-pawn kinematics (position, velocity, angle, angular velocity) so
 *     physics bodies can be rebuilt deterministically
 *
 * There is NO turn queue and NO current player: rounds are SIMULTANEOUS.
 * Every alive player picks aim + power and confirms independently; the
 * round's movements start together when all alive players have confirmed
 * (or the server resolves the round — its decision deadline). The
 * `confirmed` flag is per-round: it resets for every new aiming phase.
 *
 * Deliberately EXCLUDED:
 *   - rendering/presentation data (see GameStateSnapshot in types.ts)
 *   - client-owned data (which pawn is "local" — the engine has no local
 *     player; callers supply identity to projectSnapshot)
 *   - physics-engine bookkeeping (collision pairs) — there is no wall
 *     state at all: pawns collide with each other only, so nothing
 *     collision-related needs serialization.
 *
 * A future server can therefore: simulate → getState() → serializeGameState()
 * → send; and a client (or another server) can: deserializeGameState() →
 * engine.loadState() → continue identical simulation.
 */

/** Serializable aim selection of a single pawn. */
export interface PawnAimState {
  /** Whether this pawn's player has picked an aim direction. */
  active: boolean;
  /** Aim direction as a unit vector (from the pawn toward the target). */
  direction: Vec2;
}

/** The launch one pawn committed for the round being resolved. */
export interface LaunchSelection {
  /** Launch direction as a unit vector (the direction actually launched). */
  direction: Vec2;
  /** The power level the launch was confirmed with (1..5). */
  power: number;
}

/** Serializable state of a single pawn: domain data + controls + kinematics. */
export interface PawnState {
  id: string;
  name: string;
  /** Index into the color palette (player identity). */
  colorIndex: number;
  /** Radius in world units. */
  radius: number;
  /** Spawn point (used by reset). */
  spawnX: number;
  spawnY: number;
  /** Whether this pawn has been knocked out. */
  eliminated: boolean;
  /** This pawn's selected power level (1..5), kept across rounds. */
  power: number;
  /** This pawn's aim selection (reset for each new aiming round). */
  aim: PawnAimState;
  /**
   * Whether this pawn's player has CONFIRMED their move for the CURRENT
   * round. Confirmation locks aim + power for that round; the flag resets
   * for every new aiming phase. Eliminated pawns are never confirmed.
   */
  confirmed: boolean;
  /**
   * The launch this pawn COMMITTED for the round being resolved: set the
   * moment the round's movements begin (exactly the confirmed direction —
   * the explicit aim or the default fallback — and the confirmed power),
   * cleared when a NEW aiming round opens or the match is reset. null
   * while an aiming round is in progress.
   *
   * This is the REVEAL datum: during "aiming" every player's aim/power is
   * private (the projection exposes only the viewer's own); once the round
   * resolves, committed launches become public knowledge and are projected
   * to everyone. It lives in the authoritative state — not in any client —
   * so a disconnected-but-confirmed player's launch is revealed exactly
   * like anyone else's.
   */
  lastLaunch: LaunchSelection | null;
  /** Current center position in world units. */
  position: Vec2;
  /** Current velocity in world units per tick. */
  velocity: Vec2;
  /** Body orientation in radians (circle pawns: cosmetic, kept for fidelity). */
  angle: number;
  /** Body angular velocity (kept so reconstruction continues identically). */
  angularVelocity: number;
}

/**
 * The authoritative arena state: the SHRINKING playfield.
 *
 * Only the two numbers the schedule actually needs are stored — the
 * current radius and how many rounds have completed since the last
 * shrink. Everything else (floor radius, the next radius, rounds left,
 * whether to warn) is DERIVED from them through arena.ts, so there is
 * exactly one source of truth and nothing to keep in sync.
 *
 * Center and ring thickness are not stored: they never change, so they
 * stay in CONFIG.
 */
export interface ArenaState {
  /**
   * The CURRENT outer radius. Starts at CONFIG.arena.radius and drops by
   * CONFIG.arena.shrink.amount on every shrink, never below
   * CONFIG.arena.shrink.minRadius. Every geometry decision — elimination
   * above all — measures against THIS value.
   */
  radius: number;
  /**
   * Completed rounds since the last shrink (0 right after one). The
   * engine increments it when a round completes and resets it when the
   * shrink fires, so the schedule survives serialization/reconnects
   * exactly like the rest of the match.
   */
  roundsSinceShrink: number;
}

/** Serializable authoritative state of the whole match. */
export interface GameState {
  phase: GamePhase;
  /**
   * Winner pawn id once the match is finished; null while the match runs and
   * null when the match ended with no survivor. The winner is derived purely
   * from elimination state — never from any client/local perspective.
   */
  winnerId: string | null;
  /** Round state machine (simultaneous rounds — no turn queue). */
  round: {
    /** Fixed simulation ticks since the round's movements started. */
    settleTicks: number;
    /**
     * Which simultaneous round is being played, 1-based: 1 while the
     * first round is decided and resolved, 2 once it has completed, and
     * so on. INFORMATIONAL ONLY — nothing in the engine branches on it.
     *
     * It is incremented from the SAME single event that already drives
     * the shrink schedule (one completed round; see
     * advanceShrinkSchedule), so it cannot drift out of step with
     * `arena.roundsSinceShrink` — it is that same tick, counted without
     * the every-3 reset so it can be spoken as an ordinal.
     *
     * ADDITIVE and backward-safe like `arena`: the engine always writes
     * it, but it is OPTIONAL so states serialized before it existed stay
     * loadable (they resume at round 1).
     */
    number?: number;
  };
  /**
   * The shrinking arena's authoritative state.
   *
   * ADDITIVE and backward-safe: the engine always writes it, but the
   * field is OPTIONAL so states serialized before the mechanic existed
   * stay loadable — they simply describe a fresh full-size arena (see
   * validateGameState / loadState). A present value is fully validated,
   * including the legal radius range.
   */
  arena?: ArenaState;
  /** All pawns in the match (eliminated pawns stay listed). */
  pawns: PawnState[];
}

/**
 * Validate an arbitrary value as a GameState (trust boundary for anything
 * that arrived from outside the process, e.g. a future network layer).
 * Returns the state untouched when valid; throws an Error describing the
 * first problem found otherwise.
 */
export function validateGameState(candidate: unknown): GameState {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("GameState: not an object");
  }
  const s = candidate as Record<string, unknown>;

  if (
    s.phase !== "aiming" &&
    s.phase !== "moving" &&
    s.phase !== "finished"
  ) {
    throw new Error(`GameState: invalid phase ${JSON.stringify(s.phase)}`);
  }

  const pawnIds = new Set<string>();
  if (!Array.isArray(s.pawns) || s.pawns.length === 0) {
    throw new Error("GameState: pawns must be a non-empty array");
  }
  for (const raw of s.pawns) {
    const p = validatePawn(raw);
    if (pawnIds.has(p.id)) {
      throw new Error(`GameState: duplicate pawn id ${p.id}`);
    }
    pawnIds.add(p.id);
  }

  // Winner cross-field invariants: only a finished match has a winner, and
  // the winner must be a known pawn that is still standing.
  if (s.winnerId !== null && s.winnerId !== undefined && typeof s.winnerId !== "string") {
    throw new Error("GameState: winnerId must be a string or null");
  }
  const winnerId = (s.winnerId ?? null) as string | null;
  if (winnerId !== null) {
    if (s.phase !== "finished") {
      throw new Error("GameState: winnerId is set but the match is not finished");
    }
    if (!pawnIds.has(winnerId)) {
      throw new Error(`GameState: winnerId references unknown pawn ${winnerId}`);
    }
    const winner = (s.pawns as PawnState[]).find((p) => p.id === winnerId);
    if (winner && winner.eliminated) {
      throw new Error(`GameState: winnerId references eliminated pawn ${winnerId}`);
    }
  }

  const round = s.round;
  if (typeof round !== "object" || round === null) {
    throw new Error("GameState: missing round");
  }
  const r = round as Record<string, unknown>;
  if (!isInteger(r.settleTicks) || r.settleTicks < 0) {
    throw new Error("GameState: round.settleTicks must be a non-negative integer");
  }
  // Optional (see the field doc): absent is legal and resumes at round 1.
  // A present value is fully validated — untrusted input must not be able
  // to seed a nonsense ordinal.
  if (r.number !== undefined && (!isInteger(r.number) || (r.number as number) < 1)) {
    throw new Error("GameState: round.number must be a positive integer");
  }

  validateArenaState(s.arena);

  // Round invariant: an eliminated pawn never carries a confirmation
  // (it cannot participate in any round).
  for (const p of s.pawns as PawnState[]) {
    if (p.eliminated && p.confirmed) {
      throw new Error(`GameState: eliminated pawn ${p.id} must not be confirmed`);
    }
  }

  return candidate as GameState;
}

/**
 * The shrinking arena's authoritative state.
 *
 * BACKWARD-SAFE BY DESIGN: absent/null means "a match from before the
 * shrink mechanic" and is accepted — loadState then normalizes it to a
 * fresh full-size arena. A PRESENT value must be well formed and inside
 * the legal range (a client-supplied radius could otherwise enlarge the
 * arena or collapse it to a point).
 */
function validateArenaState(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("GameState: arena must be an object");
  }
  const a = raw as Record<string, unknown>;
  if (!isFiniteNumber(a.radius)) {
    throw new Error("GameState: arena.radius must be a finite number");
  }
  if (
    a.radius > CONFIG.arena.radius ||
    a.radius < CONFIG.arena.shrink.minRadius
  ) {
    throw new Error(
      `GameState: arena.radius must be within [${CONFIG.arena.shrink.minRadius}, ${CONFIG.arena.radius}]`
    );
  }
  if (!isInteger(a.roundsSinceShrink) || a.roundsSinceShrink < 0) {
    throw new Error(
      "GameState: arena.roundsSinceShrink must be a non-negative integer"
    );
  }
}

function validatePawn(raw: unknown): PawnState {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("GameState: pawn is not an object");
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0) {
    throw new Error("GameState: pawn.id must be a non-empty string");
  }
  if (typeof p.name !== "string") {
    throw new Error(`GameState: pawn ${p.id} name must be a string`);
  }
  if (!isInteger(p.colorIndex) || p.colorIndex < 0) {
    throw new Error(`GameState: pawn ${p.id} colorIndex must be a non-negative integer`);
  }
  if (!isFiniteNumber(p.radius) || p.radius <= 0) {
    throw new Error(`GameState: pawn ${p.id} radius must be positive`);
  }
  if (!isFiniteNumber(p.spawnX) || !isFiniteNumber(p.spawnY)) {
    throw new Error(`GameState: pawn ${p.id} spawn must be finite numbers`);
  }
  if (typeof p.eliminated !== "boolean") {
    throw new Error(`GameState: pawn ${p.id} eliminated must be a boolean`);
  }
  if (typeof p.confirmed !== "boolean") {
    throw new Error(`GameState: pawn ${p.id} confirmed must be a boolean`);
  }
  if (
    !isInteger(p.power) ||
    p.power < CONFIG.power.min ||
    p.power > CONFIG.power.max
  ) {
    throw new Error(
      `GameState: pawn ${p.id} power must be an integer in [${CONFIG.power.min}, ${CONFIG.power.max}]`
    );
  }
  const aim = p.aim;
  if (typeof aim !== "object" || aim === null) {
    throw new Error(`GameState: pawn ${p.id} missing aim`);
  }
  const a = aim as Record<string, unknown>;
  if (typeof a.active !== "boolean") {
    throw new Error(`GameState: pawn ${p.id} aim.active is not a boolean`);
  }
  const direction = validateVec2(a.direction, `pawn ${p.id} aim.direction`);
  if (Math.hypot(direction.x, direction.y) > 1 + 1e-6) {
    throw new Error(`GameState: pawn ${p.id} aim.direction is not a unit vector`);
  }
  validateVec2(p.position, `pawn ${p.id} position`);
  validateVec2(p.velocity, `pawn ${p.id} velocity`);
  if (!isFiniteNumber(p.angle)) {
    throw new Error(`GameState: pawn ${p.id} angle must be finite`);
  }
  if (!isFiniteNumber(p.angularVelocity)) {
    throw new Error(`GameState: pawn ${p.id} angularVelocity must be finite`);
  }
  validateLastLaunch(p.lastLaunch, p.id);
  return raw as PawnState;
}

/**
 * The committed-launch reveal datum. Absent/null means "no committed
 * launch" (an aiming round, or a pawn that did not confirm). Tolerating
 * ABSENCE keeps states produced by older engine versions loadable; a
 * present value must be a well-formed launch.
 */
function validateLastLaunch(raw: unknown, pawnId: string): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object") {
    throw new Error(`GameState: pawn ${pawnId} lastLaunch must be an object or null`);
  }
  const l = raw as Record<string, unknown>;
  const direction = validateVec2(l.direction, `pawn ${pawnId} lastLaunch.direction`);
  if (Math.hypot(direction.x, direction.y) > 1 + 1e-6) {
    throw new Error(
      `GameState: pawn ${pawnId} lastLaunch.direction is not a unit vector`
    );
  }
  if (!isInteger(l.power) || l.power < CONFIG.power.min || l.power > CONFIG.power.max) {
    throw new Error(
      `GameState: pawn ${pawnId} lastLaunch.power must be an integer in [${CONFIG.power.min}, ${CONFIG.power.max}]`
    );
  }
}

function validateVec2(raw: unknown, what: string): Vec2 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`GameState: ${what} is not an object`);
  }
  const v = raw as Record<string, unknown>;
  if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y)) {
    throw new Error(`GameState: ${what} must be finite numbers`);
  }
  return raw as Vec2;
}

/**
 * Serialization boundary: GameState → JSON string.
 * (GameState is plain data, so JSON.stringify is lossless by construction;
 * the helper exists so the wire format has exactly one owner.)
 */
export function serializeGameState(state: GameState): string {
  return JSON.stringify(state);
}

/**
 * Deserialization boundary: JSON string → validated GameState.
 * Throws on invalid JSON or any shape violation.
 */
export function deserializeGameState(json: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`GameState: invalid JSON (${(err as Error).message})`);
  }
  return validateGameState(parsed);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}
