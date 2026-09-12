import { CONFIG } from "./config";

/**
 * Arena model. Describes the circular playfield and provides helpers for
 * boundary containment / elimination checks.
 *
 * There is NO physical wall around the arena: pawns glide freely past
 * the floor edge, and leaving it eliminates them by pure geometry
 * (isPawnOutOfBounds). `wallThickness` is only the width of the VISUAL
 * boundary ring drawn around the floor — the logical floor ends at
 * radius - wallThickness.
 *
 * THE RADIUS IS NOT CONSTANT: the arena SHRINKS on the authoritative
 * schedule in CONFIG.arena.shrink (every N completed rounds, between
 * rounds, down to a minimum). The current radius is authoritative match
 * state (GameState.arena.radius), so every consumer — elimination,
 * settling, spawning, rendering — must read it from the arena object /
 * snapshot it was handed, never from CONFIG (which only holds the
 * INITIAL radius a match starts at). All the schedule math lives here so
 * engine, server and UI share one implementation.
 *
 * Kept as pure data + math so the same logic can run server-side later.
 */
export interface Arena {
  centerX: number;
  centerY: number;
  /** CURRENT outer radius: edge of the visual boundary ring. */
  radius: number;
  /** Width of the visual boundary ring (not a collider). */
  wallThickness: number;
}

/**
 * Build an arena. Without an argument it starts at the configured INITIAL
 * radius (a fresh match); callers holding authoritative state — a loaded
 * GameState, a received snapshot — pass the CURRENT radius so the geometry
 * they compute (and draw) matches the server's.
 */
export function createArena(radius?: number): Arena {
  const a = CONFIG.arena;
  return {
    centerX: a.centerX,
    centerY: a.centerY,
    radius: clampArenaRadius(radius ?? a.radius),
    wallThickness: a.wallThickness,
  };
}

/** The inner floor radius (where the playable surface ends). */
export function floorRadius(arena: Arena): number {
  return arena.radius - arena.wallThickness;
}

/**
 * The single authoritative elimination rule: a pawn is out of bounds when it
 * has completely left the playable floor — the distance from the arena
 * center exceeds the floor radius by more than the pawn's own radius, i.e.
 * no part of the pawn touches the playfield anymore.
 *
 * Pure geometry (no velocity heuristics, no magic thresholds) against the
 * CURRENT radius: the same check works identically on client and server,
 * and a shrink changes the verdict simply by changing the radius.
 */
export function isPawnOutOfBounds(
  arena: Arena,
  x: number,
  y: number,
  pawnRadius: number
): boolean {
  const dx = x - arena.centerX;
  const dy = y - arena.centerY;
  return Math.hypot(dx, dy) > floorRadius(arena) + pawnRadius;
}

/** A spawn point just inside the floor, given an angle in radians. */
export function spawnPositionAtAngle(arena: Arena, angle: number): [number, number] {
  const r = spawnRingRadius(arena);
  return [
    arena.centerX + Math.cos(angle) * r,
    arena.centerY + Math.sin(angle) * r,
  ];
}

/**
 * The radius of the ring every pawn spawns on: just inside the floor,
 * with a small margin so no pawn starts touching the rim. Derived from
 * the arena's CURRENT radius, so a shrink moves the ring with it.
 */
export function spawnRingRadius(arena: Arena): number {
  return floorRadius(arena) - CONFIG.pawn.radius - CONFIG.arena.spawnMargin;
}

/**
 * The FIXED spawn slots: `CONFIG.match.maxPlayers` positions spaced
 * evenly around the arena (60° apart for six), in the order seats are
 * handed out.
 *
 * The slots are a property of the ARENA, not of the turnout: seat i
 * always gets slot i, so a match with fewer players simply leaves the
 * unused slots empty rather than re-spacing everyone. That keeps the
 * geometry predictable — the same seat is always in the same place —
 * and is why this is the only spawn-position source in the codebase.
 *
 * SLOT ORDER is chosen so small matches stay spread out instead of
 * clustering on one side: the first two slots are diametrically opposed
 * (left and right), the next two are the opposing pair rotated 120°,
 * and the last two complete the hexagon. Six players therefore occupy a
 * perfect hexagon, while two, three or four players are still well
 * distributed around the circle.
 *
 *   slot 0 → 180° (left)        slot 3 →   0° (right, +180° of slot 2)
 *   slot 1 →   0° (right)       slot 4 → 240°
 *   slot 2 → 120°               slot 5 →  60°
 *
 * (Angles are measured in canvas space: x = cos, y = sin, y growing
 * downward.)
 */
export function spawnSlotAngle(slot: number): number {
  const total = CONFIG.match.maxPlayers;
  const half = Math.floor(total / 2);
  // Pair up opposed slots: even slots walk around one half of the ring,
  // odd slots are their exact opposites. With six slots that visits
  // 180°, 0°, 300°, 120°, 60°, 240° — every 60° step, no repeats.
  const pair = Math.floor(slot / 2);
  const opposed = slot % 2 === 1;
  const base = Math.PI + (pair * 2 * Math.PI) / half;
  return base + (opposed ? Math.PI : 0);
}

/** The spawn position of a given seat, on the fixed slot ring. */
export function spawnPositionForSlot(arena: Arena, slot: number): [number, number] {
  return spawnPositionAtAngle(arena, spawnSlotAngle(slot));
}

// ──────────────────────────────────────────────────────────────────────────
// Shrinking arena — the authoritative schedule (CONFIG.arena.shrink)
// ──────────────────────────────────────────────────────────────────────────

/** The radius every match starts at, and the one a reset restores. */
export function initialArenaRadius(): number {
  return CONFIG.arena.radius;
}

/** The smallest playable radius: the arena never shrinks below it. */
export function minArenaRadius(): number {
  return CONFIG.arena.shrink.minRadius;
}

/** Keep any radius within [minimum, initial] — the legal range. */
export function clampArenaRadius(radius: number): number {
  if (!Number.isFinite(radius)) return CONFIG.arena.radius;
  return Math.min(CONFIG.arena.radius, Math.max(CONFIG.arena.shrink.minRadius, radius));
}

/** Whether the arena has reached its minimum size (no shrink left). */
export function isMinArenaRadius(radius: number): boolean {
  return radius <= CONFIG.arena.shrink.minRadius;
}

/**
 * The radius ONE shrink event produces, clamped at the minimum. Returns the
 * input unchanged once the minimum is reached — the schedule keeps ticking,
 * it simply stops having an effect.
 */
export function shrunkArenaRadius(radius: number): number {
  return clampArenaRadius(radius - CONFIG.arena.shrink.amount);
}

/**
 * Whether a completed round triggers a shrink, given how many rounds have
 * completed since the last one. Pure schedule arithmetic (no clock, no
 * randomness): the same count always yields the same verdict, on every
 * machine and after any state transfer.
 */
export function shrinkDueAfterRound(roundsSinceShrink: number): boolean {
  return roundsSinceShrink >= CONFIG.arena.shrink.everyRounds;
}

/**
 * THE client-side accessor: the arena geometry a snapshot describes.
 *
 * Every consumer that draws or measures the arena from a snapshot goes
 * through this — renderer, effects, input mapping — so the authoritative
 * radius reaches them all by the same path and the "older/hand-built
 * snapshot has no arena field" fallback (full size) exists exactly once.
 * Reading `snapshot.arena.radius` by hand anywhere else would duplicate
 * that rule; this function is the reason nothing needs to.
 */
export function arenaFromSnapshot(snapshot: {
  arena?: { radius: number };
}): Arena {
  return createArena(snapshot.arena?.radius);
}

/**
 * Presentation view of the schedule, derived purely from authoritative
 * state (current radius + completed rounds since the last shrink):
 *
 *   - roundsUntilShrink: how many more rounds must COMPLETE before the
 *     arena shrinks — null once the minimum radius is reached;
 *   - nextRadius: the radius that shrink will apply — null at the minimum;
 *   - warning: whether the shrink is close enough to warn players about
 *     (CONFIG.arena.shrink.warnBeforeRounds), i.e. the shrink lands when
 *     the CURRENT round completes. Always false at the minimum radius, so
 *     the warning cannot linger once shrinking is over.
 *
 * Clients render this straight from the snapshot — they never count rounds
 * themselves.
 */
export function arenaShrinkView(
  radius: number,
  roundsSinceShrink: number
): {
  roundsUntilShrink: number | null;
  nextRadius: number | null;
  warning: boolean;
} {
  if (isMinArenaRadius(radius)) {
    return { roundsUntilShrink: null, nextRadius: null, warning: false };
  }
  const remaining = Math.max(
    0,
    CONFIG.arena.shrink.everyRounds - roundsSinceShrink
  );
  return {
    roundsUntilShrink: remaining,
    nextRadius: shrunkArenaRadius(radius),
    warning: remaining <= CONFIG.arena.shrink.warnBeforeRounds,
  };
}
