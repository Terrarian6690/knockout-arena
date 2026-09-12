/**
 * View types bridging the engine core and the React UI.
 *
 * These describe what the CLIENT needs (rendering, input, presentation).
 * Authoritative, serializable state lives in state.ts; player intentions
 * (commands) live in commands.ts.
 */

/** A 2D vector in world coordinates. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Snapshot of a single pawn for rendering / UI. */
export interface PawnSnapshot {
  /** Stable id within the match. */
  id: string;
  /** Display name (e.g. for the winner announcement). */
  name: string;
  position: Vec2;
  velocity: Vec2;
  /** Radius in world units. */
  radius: number;
  /** Whether this pawn has been knocked out of the arena. */
  eliminated: boolean;
  /**
   * Whether this pawn's player has locked in their move for the CURRENT
   * round (meaningful during the aiming phase; always false for
   * eliminated pawns). Public by design: readiness is everyone's
   * business, and it reveals NOTHING about the direction or power.
   */
  confirmed: boolean;
  /**
   * The launch this pawn COMMITTED for the round being resolved — the
   * public reveal of a previously private choice. Non-null only while the
   * round is resolving ("moving") or the match has finished: the
   * projection hard-nulls it during "aiming", so other players' current
   * aim/power are structurally never on the wire. Unconfirmed pawns never
   * carry one (null = no launch arrow — never a guessed one).
   */
  launch: { direction: Vec2; power: number } | null;
  /** Whether this pawn belongs to the local player (client projection only). */
  isLocal: boolean;
  /** Color key (index into the player palette). */
  colorIndex: number;
}

/**
 * The explicit phase of a match. The engine is in exactly one phase at a
 * time and every input is gated by it:
 *
 *   aiming   - the SHARED decision round: every alive player may aim and
 *              pick a power level, and confirms independently. The phase
 *              ends when all alive players have confirmed (or the server
 *              resolves the round via `resolveRound`).
 *   moving   - the round's confirmed launches are resolving TOGETHER;
 *              physics runs until every survivor settles. Eliminations of
 *              ANY pawn can happen while moving (a mover can knock
 *              opponents off the floor — and movers can collide).
 *   finished - terminal: at most one pawn remains active. `winnerId`
 *              identifies the survivor, or null when nobody survived
 *              (e.g. a single-player loss). Only `reset` is accepted.
 *
 * Elimination is NOT a phase: it is a per-pawn flag. A match continues
 * after eliminations while two or more active pawns remain.
 */
export type GamePhase = "aiming" | "moving" | "finished";

/**
 * Immutable-ish summary of game state fed to the UI each frame. This is a
 * CLIENT-FACING PROJECTION of GameState (see state.ts): it adds presentation
 * flags (isMoving, isAiming, isLocal) and omits reconstruction details.
 *
 * The engine itself produces only the spectator projection
 * (localPawnId: null); local perspective is added by the client calling
 * projectSnapshot(state, localPawnId) - the engine never knows who is "me".
 */
/**
 * The shrinking arena as clients see it — pure projection of the
 * authoritative arena state (never a client-side computation).
 *
 * `radius` is what the renderer draws and what the elimination boundary
 * measures against; the rest is the warning/countdown material, DERIVED
 * server-side from the same state so every client shows the same thing.
 */
export interface ArenaSnapshot {
  /** The CURRENT authoritative outer radius. */
  radius: number;
  /**
   * How many more rounds must COMPLETE before the arena shrinks, or null
   * once the minimum radius is reached (no shrink will ever come).
   */
  roundsUntilShrink: number | null;
  /** The radius the next shrink will apply; null at the minimum. */
  nextRadius: number | null;
  /**
   * Whether players should be WARNED that a shrink is imminent (it lands
   * when the current round completes). False once the arena has reached
   * its minimum, so the warning disappears for good after the last
   * shrink — and false again immediately after each shrink lands.
   */
  shrinkWarning: boolean;
  /** Whether the arena has reached its minimum size. */
  atMinRadius: boolean;
}

export interface GameStateSnapshot {
  phase: GamePhase;
  pawns: PawnSnapshot[];
  /**
   * The pawn this projection is localized to, or null for the engine's own
   * spectator view. Supplied by the CLIENT, never chosen by the engine.
   */
  localPawnId: string | null;
  /** Winner pawn id once the match is finished (null = no survivor). */
  winnerId: string | null;
  /**
   * The shrinking arena's authoritative geometry + warning state. Every
   * client derives its rendering and its countdown from THIS — never
   * from a local constant or a locally counted round.
   *
   * ADDITIVE / BACKWARD-SAFE (like roundDeadline): projectSnapshot always
   * fills it, but the field is optional so a snapshot from an older
   * server — or any hand-built one — stays valid and simply reads as the
   * full-size arena. Consumers must go through arenaFromSnapshot() rather
   * than reading `.radius` directly, so that fallback lives in ONE place.
   */
  arena?: ArenaSnapshot;
  /**
   * The VIEWER'S OWN selected power level (1..5) — rounds are
   * simultaneous, so each player's controls describe their own pawn. The
   * neutral default for spectator projections (localPawnId null).
   */
  power: number;
  /**
   * The VIEWER'S OWN aim direction as a unit vector, or null when unset.
   * Null for spectator projections.
   */
  aimDirection: Vec2 | null;
  /**
   * Whether the viewer's own pawn has an aim target to draw (aiming phase,
   * pawn alive). False for spectator projections.
   */
  isAiming: boolean;
  /**
   * The CURRENT aiming round's decision deadline as an ABSOLUTE
   * server wall-clock timestamp (ms) — presentation metadata for
   * countdown displays. NEVER set by the engine (the engine has no wall
   * clock); the game server stamps it on viewer-projected snapshots from
   * the host's authoritative round timer. null/absent = no aiming round
   * in progress (or an older server). Presentation ONLY: a client may
   * render `max(0, roundDeadline - localNow)` but must never let it
   * decide anything gameplay-related — the server alone resolves rounds.
   */
  roundDeadline?: number | null;
  /**
   * The MATCH TIME LIMIT as an ABSOLUTE server wall-clock timestamp (ms):
   * the moment this match is hard-stopped. Presentation metadata, stamped
   * by the game server from the host's authoritative match timer exactly
   * like roundDeadline — the engine never sets it (it has no clock).
   *
   * An absolute deadline rather than a remaining-seconds number on
   * purpose: a client can re-derive `max(0, matchDeadline - now)` at any
   * moment, so late or dropped snapshots cannot make the display drift,
   * and a RECONNECTING client shows the correct remaining time from the
   * first snapshot it receives.
   *
   * null/absent = no live match timer (the lobby, a finished match, or
   * an older server). Presentation ONLY: a client may render the
   * countdown but must never let it end a match — the server alone does
   * that, through the authoritative `timeUp` path.
   */
  matchDeadline?: number | null;
}
