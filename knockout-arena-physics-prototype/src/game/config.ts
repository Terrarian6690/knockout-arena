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

  /** Circular arena definition. */
  arena: {
    centerX: 450,
    centerY: 350,
    /** Outer radius of the arena floor + rim. */
    radius: 280,
    /** Thickness of the raised rim the pawns bump against. */
    wallThickness: 16,
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
    /** Launch speed in units/tick at maximum power. */
    maxSpeed: 3.6,
    /** Exponent making higher power levels ramp up non-linearly. */
    curve: 1.5,
    /**
     * Outward radial speed at rim contact required to fly OVER the rim (the
     * rim is a low lip): fast head-on launches clear it and leave the floor,
     * slow or glancing contacts bounce back. This only decides pass-through;
     * the elimination itself is a pure geometric check (see arena.ts).
     */
    knockoutSpeed: 2.3,
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
