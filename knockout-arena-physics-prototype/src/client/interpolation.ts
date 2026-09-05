import type { GameStateSnapshot, PawnSnapshot, Vec2 } from "../game";

/**
 * Client-side snapshot interpolation — RENDER-ONLY smoothing of REMOTE pawns.
 *
 * The server stays the sole authority: this module never mutates an
 * authoritative snapshot, never feeds anything back into the game state and
 * is used exclusively by the arena's draw path. What it does:
 *
 *   • buffers the authoritative snapshots the client receives (each stamped
 *     with its LOCAL arrival time — the wire carries no per-snapshot clock,
 *     so no protocol change is involved),
 *   • renders remote pawns BETWEEN two buffered snapshots at
 *     `now - INTERPOLATION_DELAY_MS` (behind the newest arrival, so there is
 *     always a pair to interpolate within),
 *   • snaps — never smears — across state boundaries: the local pawn, every
 *     non-"moving" phase (aiming / finished), eliminations and buffer
 *     starvation all draw the newest authoritative state directly.
 *
 * There is no client-side prediction, no extrapolation and no rollback: if
 * the timeline cannot produce a pair, the newest state is drawn as-is.
 * Everything here is pure and deterministic (callers supply the clock), so
 * the module is unit-testable headlessly.
 */

/** One authoritative snapshot stamped with its client-side arrival time. */
export interface TimedSnapshot {
  readonly time: number;
  readonly snapshot: GameStateSnapshot;
}

/**
 * How far behind the newest arrival the renderer lags. The server pushes a
 * snapshot per simulation tick while the round resolves (~16.7 ms at the
 * fixed 60 Hz step), so 50 ms ≈ three ticks of slack: occasional jitter
 * (40/60/80 ms gaps) still lands inside the buffer instead of starving it.
 */
export const INTERPOLATION_DELAY_MS = 50;

/** Hard bound on buffered snapshots — the buffer can never grow unbounded. */
export const MAX_BUFFERED_SNAPSHOTS = 8;

/** Entries older than the newest one by more than this are dropped. */
export const MAX_SNAPSHOT_AGE_MS = 250;

/**
 * Two distinct snapshots that arrive within the same millisecond (e.g. a
 * burst after a stall) are kept chronologically honest by nudging the newer
 * one this far ahead instead of collapsing both onto one timestamp.
 */
const SAME_TIME_STEP_MS = 1;

/**
 * The interpolation clock. Monotonic where available: `performance.now()`
 * never jumps on wall-clock adjustments, which `Date.now()` can (NTP sync).
 * Both pushes and render times MUST come from this same clock.
 */
export function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * The interpolation factor for a render time between two arrival times:
 * `(renderTime - prevTime) / (nextTime - prevTime)`, clamped to [0, 1].
 * Identical timestamps (dt = 0) and any non-finite input resolve to 1 —
 * "draw the newer snapshot" — never to NaN.
 */
export function interpolationAlpha(
  prevTime: number,
  nextTime: number,
  renderTime: number
): number {
  const dt = nextTime - prevTime;
  if (!Number.isFinite(dt) || dt <= 0) return 1;
  const alpha = (renderTime - prevTime) / dt;
  if (!Number.isFinite(alpha)) return 1;
  return Math.min(1, Math.max(0, alpha));
}

/**
 * Linear interpolation between two positions, clamped to `alpha ∈ [0, 1]`.
 * Never returns NaN/Infinity: if either endpoint (or alpha) is not finite,
 * the newest finite endpoint wins; if neither is, the origin does.
 */
export function lerpPosition(from: Vec2, to: Vec2, alpha: number): Vec2 {
  if (!Number.isFinite(alpha)) return { x: to.x, y: to.y };
  const t = Math.min(1, Math.max(0, alpha));
  const fromOk =
    Number.isFinite(from.x) && Number.isFinite(from.y);
  const toOk = Number.isFinite(to.x) && Number.isFinite(to.y);
  if (fromOk && toOk) {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  if (toOk) return { x: to.x, y: to.y };
  if (fromOk) return { x: from.x, y: from.y };
  return { x: 0, y: 0 };
}

/** Whether two pawns occupy the same visual state (cheap, no allocation). */
function samePawn(a: PawnSnapshot, b: PawnSnapshot): boolean {
  return (
    a.id === b.id &&
    a.eliminated === b.eliminated &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.velocity.x === b.velocity.x &&
    a.velocity.y === b.velocity.y
  );
}

/**
 * Whether two snapshots are visually identical (phase + pawn motion state).
 * Used ONLY to drop exact duplicates that arrive with the same timestamp —
 * a cheaper comparison would be reference equality, but every wire message
 * is freshly parsed, so identities never match.
 */
function sameVisualState(a: GameStateSnapshot, b: GameStateSnapshot): boolean {
  if (a.phase !== b.phase || a.pawns.length !== b.pawns.length) return false;
  return a.pawns.every((pawnA, i) => {
    const pawnB = b.pawns[i];
    return pawnB !== undefined && samePawn(pawnA, pawnB);
  });
}

/**
 * A bounded, chronological buffer of arrival-stamped snapshots.
 *
 * Push rules (all O(1) except the tiny prune):
 *   • a timestamp older than the newest buffered one is IGNORED — the
 *     timeline never moves backwards and the newest state is preserved;
 *   • an exact duplicate at the same timestamp is dropped;
 *   • a different snapshot at the same timestamp is nudged forward
 *     chronologically;
 *   • a PHASE CHANGE clears the buffer first, so no pair ever straddles
 *     aiming → moving, moving → aiming, moving → finished, resets or new
 *     rounds — boundaries snap instead of smearing;
 *   • the buffer keeps at most `MAX_BUFFERED_SNAPSHOTS` entries and no
 *     entries older than `MAX_SNAPSHOT_AGE_MS` behind the newest.
 */
export class SnapshotBuffer {
  private entries: TimedSnapshot[] = [];

  /** Buffer a snapshot; returns whether it was actually accepted. */
  push(snapshot: GameStateSnapshot, time: number): boolean {
    const entries = this.entries;
    const last = entries[entries.length - 1];
    if (last !== undefined) {
      if (time < last.time) return false; // late / out of order — keep newest
      if (time === last.time) {
        if (sameVisualState(last.snapshot, snapshot)) return false; // duplicate
        time = last.time + SAME_TIME_STEP_MS;
      }
      if (snapshot.phase !== last.snapshot.phase) entries.length = 0; // boundary
    }
    entries.push({ time, snapshot });
    this.prune();
    return true;
  }

  /** Drop everything (used on teardown; pushes handle phase boundaries). */
  reset(): void {
    this.entries = [];
  }

  /** Number of buffered snapshots. */
  get size(): number {
    return this.entries.length;
  }

  /** The newest buffered entry (null when empty). */
  latest(): TimedSnapshot | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /** Read-only view of the buffered entries (oldest first). */
  snapshotTimes(): readonly number[] {
    return this.entries.map((entry) => entry.time);
  }

  /**
   * The adjacent pair the given render time falls between, or null when no
   * pair brackets it (empty/single-entry buffer, render time at or past the
   * newest arrival, or behind the retained history). Callers fall back to
   * the newest authoritative snapshot in every null case.
   */
  pairFor(
    renderTime: number
  ): readonly [TimedSnapshot, TimedSnapshot] | null {
    const entries = this.entries;
    const lastIdx = entries.length - 1;
    if (lastIdx < 1) return null;
    if (renderTime >= entries[lastIdx].time) return null; // starved → snap
    if (renderTime < entries[0].time) return null; // stalled past history → snap
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (entries[i].time <= renderTime) {
        return [entries[i], entries[i + 1]];
      }
    }
    return null;
  }

  /** Enforce the size and age bounds (keeps at least the newest entry). */
  private prune(): void {
    const entries = this.entries;
    while (entries.length > MAX_BUFFERED_SNAPSHOTS) entries.shift();
    const newest = entries[entries.length - 1];
    const cutoff = newest.time - MAX_SNAPSHOT_AGE_MS;
    while (entries.length > 1 && entries[0].time < cutoff) entries.shift();
  }
}

function findPawn(snapshot: GameStateSnapshot, id: string): PawnSnapshot | null {
  return snapshot.pawns.find((pawn) => pawn.id === id) ?? null;
}

/**
 * Interpolate ONE pawn's position between the buffered pair — everything
 * else about the pawn (identity, elimination, launch, colors, names) comes
 * from `latest`. Snaps (no lerp) when the pawn is the local player's (no
 * added input/display delay for your own pawn), when it is eliminated in
 * either pair member (never smear across a knockout), or when it is missing
 * from either member (nothing to interpolate from).
 */
function interpolatePawn(
  pawn: PawnSnapshot,
  prev: GameStateSnapshot,
  next: GameStateSnapshot,
  alpha: number
): PawnSnapshot {
  if (pawn.isLocal || pawn.eliminated) return pawn;
  const from = findPawn(prev, pawn.id);
  const to = findPawn(next, pawn.id);
  if (from === null || to === null || from.eliminated || to.eliminated) {
    return pawn;
  }
  if (from.position.x === to.position.x && from.position.y === to.position.y) {
    return pawn; // no motion between the pair — reuse the object as-is
  }
  return { ...pawn, position: lerpPosition(from.position, to.position, alpha) };
}

/**
 * The snapshot the arena should DRAW at `renderTime`.
 *
 * Everything except remote pawn positions is taken verbatim from `latest`
 * (the newest authoritative push — aim indicator, power, phase, rounds,
 * elimination visuals), so nothing lags behind the newest state except the
 * remote positions being smoothed. Falls back to `latest` itself (same
 * object, zero allocation) whenever interpolation does not apply:
 *
 *   • not in the "moving" phase — aiming must feel instant, finished shows
 *     the authoritative final positions;
 *   • no bracketing pair in the buffer (first snapshot after a boundary,
 *     starved timeline, stalled history) — the newest state, never a
 *     freeze and never an extrapolation;
 *   • the render time already caught up with the pair's newer end.
 */
export function interpolateSnapshot(
  buffer: SnapshotBuffer,
  renderTime: number,
  latest: GameStateSnapshot
): GameStateSnapshot {
  if (latest.phase !== "moving") return latest;
  const pair = buffer.pairFor(renderTime);
  if (pair === null) return latest;
  const [prev, next] = pair;
  // Defensive: pushes reset on phase changes, so a pair never straddles
  // phases — but if one ever did, snap rather than interpolate.
  if (prev.snapshot.phase !== "moving" || next.snapshot.phase !== "moving") {
    return latest;
  }
  const alpha = interpolationAlpha(prev.time, next.time, renderTime);
  if (alpha === 1) return latest;
  return {
    ...latest,
    pawns: latest.pawns.map((pawn) =>
      interpolatePawn(pawn, prev.snapshot, next.snapshot, alpha)
    ),
  };
}
