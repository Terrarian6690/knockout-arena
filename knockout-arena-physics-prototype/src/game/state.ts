import type { GamePhase, Vec2 } from "./types";

/**
 * The serializable, authoritative game state.
 *
 * GameState contains EVERYTHING needed to reconstruct a match inside a fresh
 * engine instance — no Matter.js internals, no functions, no object
 * references, only plain JSON data:
 *
 *   - the phase machine (phase, turn queue, active index, settle ticks)
 *   - per-pawn domain state (identity, colors, spawn, elimination flag)
 *   - per-pawn kinematics (position, velocity, angle, angular velocity) so
 *     physics bodies can be rebuilt deterministically
 *   - the active player's aim and power selection
 *
 * Deliberately EXCLUDED:
 *   - rendering/presentation data (see GameStateSnapshot in types.ts)
 *   - client-owned data (localPawnId & co.)
 *   - physics-engine bookkeeping (collision pairs, rim pass-over flags) —
 *     the rim pass-over decision is re-derived from position + velocity on
 *     every tick, so it needs no serialization.
 *
 * A future server can therefore: simulate → getState() → serializeGameState()
 * → send; and a client (or another server) can: deserializeGameState() →
 * engine.loadState() → continue identical simulation.
 */

/** Serializable state of a single pawn: domain data + kinematics. */
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
  /** Selected power level (1..5). */
  power: number;
  /** The active player's aim. */
  aim: {
    active: boolean;
    direction: Vec2;
  };
  /** Turn state machine. */
  turn: {
    /** Pawn ids in turn order. */
    queue: string[];
    /** Index of the currently acting pawn. */
    activeIndex: number;
    /** Fixed simulation ticks since the active pawn launched. */
    settleTicks: number;
  };
  /** All pawns in the match. */
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

  if (s.phase !== "aiming" && s.phase !== "moving" && s.phase !== "eliminated") {
    throw new Error(`GameState: invalid phase ${JSON.stringify(s.phase)}`);
  }
  if (!isFiniteNumber(s.power)) {
    throw new Error("GameState: power is not a finite number");
  }

  const aim = s.aim;
  if (typeof aim !== "object" || aim === null) {
    throw new Error("GameState: missing aim");
  }
  const a = aim as Record<string, unknown>;
  if (typeof a.active !== "boolean") {
    throw new Error("GameState: aim.active is not a boolean");
  }
  const direction = validateVec2(a.direction, "aim.direction");
  if (Math.hypot(direction.x, direction.y) > 1 + 1e-6) {
    throw new Error("GameState: aim.direction is not a unit vector");
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
  if (!isInteger(t.activeIndex) || t.activeIndex < 0 || t.activeIndex >= t.queue.length) {
    throw new Error("GameState: turn.activeIndex out of range");
  }
  if (!isInteger(t.settleTicks) || t.settleTicks < 0) {
    throw new Error("GameState: turn.settleTicks must be a non-negative integer");
  }

  if (!Array.isArray(s.pawns) || s.pawns.length === 0) {
    throw new Error("GameState: pawns must be a non-empty array");
  }
  const pawnIds = new Set<string>();
  for (const raw of s.pawns) {
    const p = validatePawn(raw);
    if (pawnIds.has(p.id)) {
      throw new Error(`GameState: duplicate pawn id ${p.id}`);
    }
    pawnIds.add(p.id);
  }
  for (const id of t.queue) {
    if (!pawnIds.has(id as string)) {
      throw new Error(`GameState: turn.queue references unknown pawn ${id}`);
    }
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
