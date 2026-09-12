/**
 * Central tuning constants for Knockout Arena.
 *
 * Keeping every "feel" number here makes balancing trivial and keeps the rest
 * of the engine free of magic numbers. Distances are in world units; speeds are
 * in world units per simulation tick (~16.6ms at 60fps).
 */
export const CONFIG = {
  /** Logical world size in pixels (rendering is scaled to fit the canvas). */
  world: {
    width: 900,
    height: 700,
  },

  /**
   * Circular arena definition — the SINGLE source of truth for the
   * playfield geometry. Spawns, the logical elimination boundary, pawn
   * resting projection and all rendering derive from these numbers.
   */
  arena: {
    centerX: 450,
    centerY: 350,
    /**
     * INITIAL outer radius of the arena (edge of the visual boundary
     * ring) at the start of every match. There is NO physical wall:
     * launched pawns glide straight past the floor edge, and crossing it
     * eliminates them by pure geometry.
     *
     * The radius is no longer constant for a whole match: the arena
     * SHRINKS on the authoritative schedule below. Never read this value
     * as "the current radius" — that lives in the authoritative game
     * state (GameState.arena.radius) and reaches clients through the
     * snapshot. This is only where a match STARTS (and what a reset
     * restores).
     */
    radius: 330,
    /**
     * Width of the VISUAL boundary ring marking the floor edge. Not a
     * collider — the playable floor ends at radius - wallThickness and
     * the elimination rule measures from there (see arena.ts).
     */
    wallThickness: 16,
    /**
     * How far INSIDE the floor edge pawns spawn: the spawn ring sits at
     * floor − pawnRadius − spawnMargin (see arena.ts, the single source
     * of spawn positions).
     *
     * Sized against the shrink step on purpose. With the old margin of 8
     * the ring landed at 290, which is EXACTLY the elimination boundary
     * after the first shrink (floor 274 + pawnRadius 16 = 290) — pawns
     * survived only because `>` is strict and axis-aligned spawns come
     * out to exactly 290.0. Any spawn at an off-axis angle rounded to
     * 290.00000000000006 and was wiped out the moment the arena first
     * shrank. 16 keeps a real 8-unit clearance at every angle.
     */
    spawnMargin: 16,
    /**
     * The shrinking-arena schedule — the SINGLE source of truth for the
     * mechanic (engine, server and UI all derive from these numbers; no
     * client-side constant duplicates them).
     *
     * The arena shrinks BETWEEN rounds only: when a round completes (all
     * movement settled) the authoritative engine advances the schedule,
     * and every `everyRounds` completed rounds the radius drops by
     * `amount` — down to `minRadius` and never below it. Once the
     * minimum is reached the interval keeps elapsing harmlessly: no
     * further shrink happens.
     *
     * 330 → 290 → 250 → 210 → 180: four shrinks, after 3, 6, 9 and 12
     * completed rounds (the last one clamped by the minimum), with the
     * floor following at radius − wallThickness: 314 → 274 → 234 → 194
     * → 164. Every later interval elapses without effect.
     *
     * The step is deliberately LARGER than the margin a settled pawn
     * keeps from the edge (wallThickness + pawnRadius + 1 = 33): a pawn
     * that ends a round hugging the rim is genuinely caught by the next
     * boundary and eliminated, so the mechanic really does close the
     * space. It is small enough, though, that the FIRST shrink does not
     * instantly wipe out everyone who is still standing on the spawn
     * ring (282, see arena.spawnMargin) — the pressure builds over
     * rounds instead of ending the match in one stroke.
     */
    shrink: {
      /** Completed rounds between two shrinks. */
      everyRounds: 3,
      /** How much the radius drops per shrink event (world units). */
      amount: 40,
      /**
       * The MINIMUM playable radius. The arena never shrinks below it
       * (floor 164 — still room for four pawns and a real fight).
       */
      minRadius: 180,
      /**
       * How many completed rounds before a shrink the warning is shown.
       * 1 = the warning appears for the round whose completion triggers
       * the shrink, and disappears the moment the shrink lands.
       */
      warnBeforeRounds: 1,
    },
  },

  /**
   * Pawn (player body) definition.
   *
   * NOTE: because gravity is disabled (top-down view) there is no normal force,
   * so Matter's `friction` has nothing to act on. The only velocity decay while
   * gliding is `frictionAir`, which gives a clean, exponential slow-down that is
   * easy to reason about for balancing.
   */
  pawn: {
    radius: 16,
    density: 0.004,
    friction: 0.05,
    frictionAir: 0.016,
    frictionStatic: 0,
    restitution: 0.58,
  },

  /** Launch / knockback tuning. */
  launch: {
    /**
     * Launch speed in units/tick at maximum power (exactly 3× the
     * original 3.6 — every level scales through the same curve, so the
     * relative differences between powers 1–5 are unchanged).
     */
    maxSpeed: 10.8,
    /** Exponent making higher power levels ramp up non-linearly. */
    curve: 1.5,
    // NOTE: there is deliberately no rim-clearing speed threshold anymore.
    // The arena has no physical wall, so EVERY outward launch — however
    // gentle — leaves the floor unimpeded; elimination is decided purely
    // by the geometric boundary check (see arena.ts).
  },

  /**
   * Match-level rules — the SINGLE source of truth for how long a match
   * may last (engine, server and UI all derive from this; no client
   * constant duplicates it).
   */
  match: {
    /**
     * Hard maximum match duration: 4 minutes of real time, measured from
     * the moment the match actually STARTS (never from lobby/waiting
     * time). When it elapses the server ends the match through the
     * ordinary authoritative path and the existing "finished" phase —
     * no new phase exists for it.
     *
     * Enforced with wall-clock time on the SERVER only (see
     * gameHost.ts), exactly like the round decision deadline: it decides
     * WHEN the engine's `timeUp` command is submitted, and never feeds
     * into the simulation, which keeps advancing by fixed ticks.
     */
    durationMs: 4 * 60 * 1000,

    /**
     * Hard multiplayer CAPACITY: the maximum number of players in one
     * match, and therefore the number of fixed spawn slots around the
     * arena (seats p0..p5).
     *
     * This is the SINGLE source of truth for capacity. The server's room
     * manager (MAX_PLAYERS) and the lobby's seat grid (MAX_SEATS) both
     * derive from it, and the spawn ring is built from it — so capacity
     * can never be raised in one place and left stale in another.
     */
    maxPlayers: 6,
  },

  /** Aiming. */
  aiming: {
    indicatorLength: 64,
    minLength: 56,
    maxLength: 200,
  },

  /** Power selection. */
  power: {
    min: 1,
    max: 5,
    default: 3,
  },

  /** Turn / motion resolution. */
  simulation: {
    /**
     * The physics always steps by this fixed delta (ms). The game loop
     * exchanges real frame time for fixed ticks via an accumulator, so the
     * simulation behaves identically on 60 / 120 / 144 Hz displays.
     */
    fixedTimestepMs: 1000 / 60,
    /**
     * Clamp for one frame's delta (tab switches, GC pauses) so the loop
     * never tries to catch up in an unbounded spiral.
     */
    maxFrameMs: 100,
    /** Below this speed the pawn is considered at rest. */
    restSpeedThreshold: 0.1,
    /**
     * Max fixed ticks we wait for the pawn to settle before stopping it
     * anyway (600 ticks = 10 s at 60 Hz, on every machine).
     */
    maxSettleTicks: 600,
  },

  colors: {
    arenaFloor: "#1b2735",
    arenaFloorInner: "#202f42",
    arenaWall: "#4f6d8f",
    arenaWallGlow: "#7ea8d1",
    background: "#0b0e14",
    pawnHighlight: "#ffffff",
    aimLine: "#ffd166",
    aimArrow: "#ffd166",
    outOfBounds: "#ef4444",
  },
} as const;

/** Launch speed (units/tick) for a given power level (1..5). */
export function launchSpeedFor(power: number): number {
  const p = Math.min(CONFIG.power.max, Math.max(CONFIG.power.min, power));
  const factor = Math.pow(p / CONFIG.power.max, CONFIG.launch.curve);
  return CONFIG.launch.maxSpeed * factor;
}
