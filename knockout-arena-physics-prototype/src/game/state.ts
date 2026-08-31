import { CONFIG } from "./config";
import type { GamePhase, Vec2 } from "./types";

/**
 * The serializable, authoritative game state.
 *
 * GameState contains EVERYTHING needed to reconstruct a match inside a fresh
 * engine instance — no Matter.js internals, no functions, no object
 * references, only plain JSON data:
 *
 *   - the phase machine (phase, winner, turn queue, active index, settle
 *     ticks)
 *   - per-pawn domain state (identity, colors, spawn, elimination flag)
 *   - per-pawn aim + power selections (each player's own controls, so a
 *     server can apply commands to the correct pawn)
 *   - per-pawn kinematics (position, velocity, angle, angular velocity) so
 *     physics bodies can be rebuilt deterministically
 *
 * Deliberately EXCLUDED:
 *   - rendering/presentation data (see GameStateSnapshot in types.ts)
 *   - client-owned data (which pawn is "local" — the engine has no local
 *     player; callers supply identity to projectSnapshot)
 *   - physics-engine bookkeeping (collision pairs, rim pass-over flags) —
 *     the rim pass-over decision is re-derived from position + velocity on
 *     every tick, so it needs no serialization.
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
  /** This pawn's selected power level (1..5), kept across other turns. */
  power: number;
  /** This pawn's aim selection, kept across other turns. */
  aim: PawnAimState;
  /** Current center position in world units. */
  position: Vec2;
  /** Current velocity in world units per tick. */
  velocity: Vec2;
  /** Body orientation in radians (circle pawns: cosmetic, kept for fidelity). */
  angle: number;
  /** Body angular velocity (kept so reconstruction continues identically). */
  angularVelocity: number;
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
  /** Turn state machine. */
  turn: {
    /**
     * ALL pawn ids in turn order — the full roster, including eliminated
     * pawns. The queue is stable for the whole match (replay-friendly);
     * rotation skips eliminated ids at runtime (see turnLogic.advanceTurn).
     */
    queue: string[];
    /** Index of the currently acting pawn. */
    activeIndex: number;
    /** Fixed simulation ticks since the active pawn launched. */
    settleTicks: number;
  };
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

  const turn = s.turn;
  if (typeof turn !== "object" || turn === null) {
    throw new Error("GameState: missing turn");
  }
  const t = turn as Record<string, unknown>;
  if (!Array.isArray(t.queue) || t.queue.length === 0) {
    throw new Error("GameState: turn.queue must be a non-empty array");
  }
  if (!t.queue.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("GameState: turn.queue entries must be non-empty strings");
  }
  const queued = new Set<string>(t.queue as string[]);
  if (queued.size !== t.queue.length) {
    throw new Error("GameState: turn.queue contains duplicate pawn ids");
  }
  for (const id of queued) {
    if (!pawnIds.has(id)) {
      throw new Error(`GameState: turn.queue references unknown pawn ${id}`);
    }
  }
  if (t.queue.length !== pawnIds.size) {
    throw new Error("GameState: turn.queue must list every pawn exactly once");
  }
  if (!isInteger(t.activeIndex) || t.activeIndex < 0 || t.activeIndex >= t.queue.length) {
    throw new Error("GameState: turn.activeIndex out of range");
  }
  if (!isInteger(t.settleTicks) || t.settleTicks < 0) {
    throw new Error("GameState: turn.settleTicks must be a non-negative integer");
  }

  return candidate as GameState;
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
  return raw as PawnState;
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
