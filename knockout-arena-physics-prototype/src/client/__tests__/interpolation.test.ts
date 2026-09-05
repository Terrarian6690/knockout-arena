import { describe, expect, it } from "vitest";
import type { GamePhase, GameStateSnapshot, PawnSnapshot } from "../../game";
import {
  INTERPOLATION_DELAY_MS,
  MAX_BUFFERED_SNAPSHOTS,
  MAX_SNAPSHOT_AGE_MS,
  SnapshotBuffer,
  interpolationAlpha,
  interpolateSnapshot,
  lerpPosition,
} from "../interpolation";

/**
 * Snapshot interpolation — the pure math and the bounded buffer behind the
 * arena's render-only smoothing. Labels follow the Task 17 spec:
 *
 *   4    interpolation math (alpha 0 / 0.5 / 1, clamping, identical
 *        timestamps, missing/non-finite inputs)
 *   3    buffer behavior (chronological, duplicates, out-of-order, bounded,
 *        too-old entries discarded)
 *   5/6  state boundaries (elimination, phase change resets) and the local
 *        pawn (never interpolated — no added display delay)
 *   8/9  fallbacks (starved/stalled timelines snap to the newest
 *        authoritative state; never NaN; never moves backwards)
 *
 * Everything is driven by explicit timestamps — no real clocks, no waits.
 */

function pawn(
  id: string,
  position: { x: number; y: number },
  overrides: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name: `Player ${id}`,
    position: { ...position },
    velocity: { x: 0, y: 0 },
    radius: 16,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: false,
    colorIndex: 0,
    ...overrides,
  };
}

function snapshot(
  phase: GamePhase,
  pawns: PawnSnapshot[],
  overrides: Partial<GameStateSnapshot> = {}
): GameStateSnapshot {
  return {
    phase,
    pawns,
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: phase === "aiming" ? { x: 1, y: 0 } : null,
    isAiming: phase === "aiming",
    ...overrides,
  };
}

describe("interpolation math", () => {
  it("computes alpha at the endpoints and the midpoint", () => {
    expect(interpolationAlpha(100, 200, 100)).toBe(0);
    expect(interpolationAlpha(100, 200, 150)).toBe(0.5);
    expect(interpolationAlpha(100, 200, 200)).toBe(1);
  });

  it("clamps alpha below 0 and above 1", () => {
    expect(interpolationAlpha(100, 200, 50)).toBe(0);
    expect(interpolationAlpha(100, 200, 250)).toBe(1);
    expect(interpolationAlpha(100, 200, -1000)).toBe(0);
    expect(interpolationAlpha(100, 200, 1000)).toBe(1);
  });

  it("treats identical timestamps as 'draw the newer one' (alpha 1)", () => {
    expect(interpolationAlpha(100, 100, 100)).toBe(1);
    expect(interpolationAlpha(100, 100, 150)).toBe(1);
    expect(interpolationAlpha(200, 100, 150)).toBe(1); // dt < 0
  });

  it("resolves non-finite times to alpha 1 (never NaN)", () => {
    expect(interpolationAlpha(Number.NaN, 200, 150)).toBe(1);
    expect(interpolationAlpha(100, Number.POSITIVE_INFINITY, 150)).toBe(1);
    expect(interpolationAlpha(100, 200, Number.NaN)).toBe(1);
  });

  it("lerps positions at alpha 0 / 0.5 / 1", () => {
    const from = { x: 0, y: 10 };
    const to = { x: 100, y: -10 };
    expect(lerpPosition(from, to, 0)).toEqual({ x: 0, y: 10 });
    expect(lerpPosition(from, to, 0.5)).toEqual({ x: 50, y: 0 });
    expect(lerpPosition(from, to, 1)).toEqual({ x: 100, y: -10 });
  });

  it("clamps the lerp factor outside [0, 1]", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 100 };
    expect(lerpPosition(from, to, -1)).toEqual({ x: 0, y: 0 });
    expect(lerpPosition(from, to, 2)).toEqual({ x: 100, y: 100 });
  });

  it("never produces NaN/Infinity from non-finite endpoints or alpha", () => {
    const finite = { x: 3, y: 4 };
    expect(lerpPosition({ x: Number.NaN, y: 0 }, finite, 0.5)).toEqual(finite);
    expect(lerpPosition(finite, { x: 0, y: Number.POSITIVE_INFINITY }, 0.5)).toEqual(finite);
    // Neither endpoint finite: the safe origin, never NaN.
    const bad = { x: Number.NaN, y: Number.POSITIVE_INFINITY };
    expect(lerpPosition(bad, bad, 0.5)).toEqual({ x: 0, y: 0 });
    expect(lerpPosition(finite, { x: 10, y: 10 }, Number.NaN)).toEqual({ x: 10, y: 10 });
  });
});

describe("snapshot buffer", () => {
  it("keeps entries in chronological push order", () => {
    const buffer = new SnapshotBuffer();
    const a = snapshot("moving", [pawn("p0", { x: 0, y: 0 }, { isLocal: true })]);
    const b = snapshot("moving", [pawn("p0", { x: 10, y: 0 }, { isLocal: true })]);
    expect(buffer.push(a, 100)).toBe(true);
    expect(buffer.push(b, 200)).toBe(true);
    expect(buffer.size).toBe(2);
    expect(buffer.snapshotTimes()).toEqual([100, 200]);
    expect(buffer.latest()?.snapshot).toBe(b);
  });

  it("drops an exact duplicate arriving with the same timestamp", () => {
    const buffer = new SnapshotBuffer();
    const a = snapshot("moving", [pawn("p0", { x: 0, y: 0 })]);
    const clone = snapshot("moving", [pawn("p0", { x: 0, y: 0 })]);
    expect(buffer.push(a, 100)).toBe(true);
    expect(buffer.push(clone, 100)).toBe(false);
    expect(buffer.size).toBe(1);
    expect(buffer.latest()?.snapshot).toBe(a);
  });

  it("keeps a DIFFERENT snapshot at the same timestamp (nudged forward)", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("moving", [pawn("p0", { x: 0, y: 0 })]), 100);
    expect(buffer.push(snapshot("moving", [pawn("p0", { x: 5, y: 0 })]), 100)).toBe(true);
    expect(buffer.size).toBe(2);
    const times = buffer.snapshotTimes();
    expect(times[1]).toBeGreaterThan(times[0]);
  });

  it("ignores a late/out-of-order timestamp (the timeline never moves backwards)", () => {
    const buffer = new SnapshotBuffer();
    const a = snapshot("moving", [pawn("p0", { x: 0, y: 0 })]);
    const b = snapshot("moving", [pawn("p0", { x: 10, y: 0 })]);
    const late = snapshot("moving", [pawn("p0", { x: 999, y: 999 })]);
    buffer.push(a, 100);
    buffer.push(b, 200);
    expect(buffer.push(late, 150)).toBe(false);
    expect(buffer.size).toBe(2);
    expect(buffer.snapshotTimes()).toEqual([100, 200]);
    // The newest valid state is preserved untouched.
    expect(buffer.latest()?.snapshot).toBe(b);
  });

  it("is bounded: keeps only the newest MAX_BUFFERED_SNAPSHOTS entries", () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i < MAX_BUFFERED_SNAPSHOTS + 6; i++) {
      buffer.push(snapshot("moving", [pawn("p0", { x: i, y: 0 })]), 100 + i * 10);
    }
    expect(buffer.size).toBe(MAX_BUFFERED_SNAPSHOTS);
    const times = buffer.snapshotTimes();
    // The OLDEST entries were dropped, the newest retained.
    expect(times[0]).toBe(100 + 6 * 10);
    expect(times[times.length - 1]).toBe(100 + (MAX_BUFFERED_SNAPSHOTS + 5) * 10);
  });

  it("discards entries too old relative to the newest arrival", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("moving", [pawn("p0", { x: 0, y: 0 })]), 0);
    buffer.push(snapshot("moving", [pawn("p0", { x: 1, y: 0 })]), 100);
    buffer.push(snapshot("moving", [pawn("p0", { x: 2, y: 0 })]), 150);
    // Newest arrival at 150 + MAX_SNAPSHOT_AGE_MS → cutoff 150: the t=0
    // and t=100 entries are now too old and dropped, t=150 retained.
    buffer.push(
      snapshot("moving", [pawn("p0", { x: 3, y: 0 })]),
      150 + MAX_SNAPSHOT_AGE_MS
    );
    expect(buffer.size).toBe(2);
    expect(buffer.snapshotTimes()).toEqual([150, 150 + MAX_SNAPSHOT_AGE_MS]);
  });


  it("clears history on a phase change (no pair ever straddles a boundary)", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("aiming", [pawn("p0", { x: 0, y: 0 })]), 100);
    buffer.push(snapshot("aiming", [pawn("p0", { x: 0, y: 0 })]), 116);
    buffer.push(
      snapshot("moving", [pawn("p0", { x: 40, y: 0 }, { launch: { direction: { x: 1, y: 0 }, power: 3 } })]),
      133
    );
    expect(buffer.size).toBe(1); // aiming → moving reset
    buffer.push(snapshot("moving", [pawn("p0", { x: 240, y: 0 })]), 150);
    expect(buffer.size).toBe(2);
    buffer.push(snapshot("aiming", [pawn("p0", { x: 0, y: 0 })]), 900); // new round
    expect(buffer.size).toBe(1); // moving → aiming reset
    expect(buffer.snapshotTimes()).toEqual([900]);
  });

  it("reset() empties the buffer", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("moving", [pawn("p0", { x: 0, y: 0 })]), 100);
    buffer.reset();
    expect(buffer.size).toBe(0);
    expect(buffer.latest()).toBeNull();
  });

  it("pairFor brackets a render time between two arrivals", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("moving", [pawn("p0", { x: 0, y: 0 })]), 100);
    buffer.push(snapshot("moving", [pawn("p0", { x: 1, y: 0 })]), 200);
    buffer.push(snapshot("moving", [pawn("p0", { x: 2, y: 0 })]), 300);
    expect(buffer.pairFor(150)).not.toBeNull();
    expect(buffer.pairFor(150)?.[0].time).toBe(100);
    expect(buffer.pairFor(150)?.[1].time).toBe(200);
    expect(buffer.pairFor(250)?.[0].time).toBe(200);
    expect(buffer.pairFor(250)?.[1].time).toBe(300);
    // Exactly on an entry: the pair starts there (alpha 0).
    expect(buffer.pairFor(200)?.[0].time).toBe(200);
  });

  it("pairFor returns null when no pair brackets the render time", () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.pairFor(100)).toBeNull(); // empty
    buffer.push(snapshot("moving", [pawn("p0", { x: 0, y: 0 })]), 100);
    expect(buffer.pairFor(100)).toBeNull(); // single entry
    expect(buffer.pairFor(50)).toBeNull(); // single entry, behind it
    buffer.push(snapshot("moving", [pawn("p0", { x: 1, y: 0 })]), 200);
    expect(buffer.pairFor(200)).toBeNull(); // at the newest arrival (starved)
    expect(buffer.pairFor(250)).toBeNull(); // past the newest arrival
    expect(buffer.pairFor(50)).toBeNull(); // behind the retained history
  });
});

/** A moving-phase match with one local and one remote pawn. */
function movingPair(
  local: { x: number; y: number },
  remote: { x: number; y: number },
  remoteOverrides: Partial<PawnSnapshot> = {}
): GameStateSnapshot {
  return snapshot("moving", [
    pawn("p0", local, { isLocal: true }),
    pawn("p1", remote, remoteOverrides),
  ]);
}

describe("interpolated snapshot", () => {
  function twoEntryBuffer() {
    const buffer = new SnapshotBuffer();
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }), 1000);
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 100, y: 40 }), 1100);
    return buffer;
  }

  it("renders a remote pawn between two authoritative positions", () => {
    const buffer = twoEntryBuffer();
    const latest = buffer.latest()!.snapshot;
    const mid = interpolateSnapshot(buffer, 1050, latest);
    expect(mid.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 50, y: 20 });
    // Alpha 0 = the older endpoint of the bracketing pair.
    const start = interpolateSnapshot(buffer, 1000, latest);
    expect(start.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 0, y: 0 });
    // Alpha 0.9 → almost caught up with the pair's newer end (float-safe
    // checks: 0.9 is not exactly representable in binary).
    const almost = interpolateSnapshot(buffer, 1090, latest);
    expect(almost.pawns.find((p) => p.id === "p1")!.position.x).toBeCloseTo(90, 6);
    expect(almost.pawns.find((p) => p.id === "p1")!.position.y).toBeCloseTo(36, 6);
    // Render time reaching the newest arrival = the newest snapshot itself.
    const end = interpolateSnapshot(buffer, 1100, latest);
    expect(end).toBe(latest);
  });

  it("interpolates remote pawns while the LOCAL pawn stays authoritative", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }), 1000);
    buffer.push(movingPair({ x: 100, y: 100 }, { x: 100, y: 40 }), 1100);
    const latest = buffer.latest()!.snapshot;
    const visual = interpolateSnapshot(buffer, 1050, latest);
    // Remote: halfway. Local: exactly the newest authoritative position —
    // never delayed by the interpolation window.
    expect(visual.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 50, y: 20 });
    expect(visual.pawns.find((p) => p.id === "p0")!.position).toEqual({ x: 100, y: 100 });
  });

  it("keeps everything but remote positions from the newest snapshot", () => {
    const buffer = twoEntryBuffer();
    const latest: GameStateSnapshot = {
      ...buffer.latest()!.snapshot,
      aimDirection: null,
      power: 5,
      roundDeadline: 12345,
    };
    const visual = interpolateSnapshot(buffer, 1050, latest);
    expect(visual.phase).toBe("moving");
    expect(visual.power).toBe(5);
    expect(visual.roundDeadline).toBe(12345);
    expect(visual.localPawnId).toBe("p0");
    // Identity/labels/colors flow through untouched.
    const remote = visual.pawns.find((p) => p.id === "p1")!;
    expect(remote.name).toBe("Player p1");
    expect(remote.colorIndex).toBe(0);
  });

  it("does not interpolate a pawn across its elimination", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }), 1000);
    buffer.push(
      movingPair({ x: 0, y: 0 }, { x: 100, y: 0 }, { eliminated: true }),
      1100
    );
    const latest = buffer.latest()!.snapshot;
    const visual = interpolateSnapshot(buffer, 1050, latest);
    const remote = visual.pawns.find((p) => p.id === "p1")!;
    // Snapped to the authoritative eliminated state — no halfway smear.
    expect(remote.eliminated).toBe(true);
    expect(remote.position).toEqual({ x: 100, y: 0 });
  });

  it("does not interpolate a pawn that was eliminated in the older member", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(
      movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }, { eliminated: true }),
      1000
    );
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 100, y: 0 }), 1100);
    const latest = buffer.latest()!.snapshot;
    const visual = interpolateSnapshot(buffer, 1050, latest);
    expect(visual.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 100, y: 0 });
  });

  it("snaps a pawn that is missing from either member of the pair", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("moving", [pawn("p0", { x: 0, y: 0 }, { isLocal: true })]), 1000);
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 100, y: 0 }), 1100);
    const latest = buffer.latest()!.snapshot;
    const visual = interpolateSnapshot(buffer, 1050, latest);
    // p1 exists only in the newer member — nothing to interpolate from.
    expect(visual.pawns.find((p) => p.id === "p1")!.position).toEqual({ x: 100, y: 0 });
  });

  it("falls back to the newest authoritative state when the buffer is starved or empty", () => {
    const buffer = new SnapshotBuffer();
    const latest = movingPair({ x: 0, y: 0 }, { x: 100, y: 0 });
    // Empty buffer.
    expect(interpolateSnapshot(buffer, 1000, latest)).toBe(latest);
    // Single entry (e.g. right after a boundary reset).
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }), 1000);
    expect(interpolateSnapshot(buffer, 1050, latest)).toBe(latest);
    // Render time at/past the newest arrival (missing snapshots — a gap).
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 100, y: 0 }), 1100);
    expect(interpolateSnapshot(buffer, 1100, latest)).toBe(latest);
    expect(interpolateSnapshot(buffer, 1200, latest)).toBe(latest);
  });

  it("falls back to the newest state when the render time stalled behind the history", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }), 1000);
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 100, y: 0 }), 1100);
    const latest = buffer.latest()!.snapshot;
    expect(interpolateSnapshot(buffer, 500, latest)).toBe(latest);
  });

  it("returns the aiming snapshot untouched (no aim/display lag)", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot("aiming", [pawn("p0", { x: 0, y: 0 }, { isLocal: true }), pawn("p1", { x: 0, y: 0 })]), 1000);
    buffer.push(snapshot("aiming", [pawn("p0", { x: 0, y: 0 }, { isLocal: true }), pawn("p1", { x: 10, y: 0 })]), 1100);
    const latest = buffer.latest()!.snapshot;
    expect(interpolateSnapshot(buffer, 1050, latest)).toBe(latest);
  });

  it("returns the finished snapshot untouched (authoritative final positions)", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 0, y: 0 }), 1000);
    buffer.push(movingPair({ x: 0, y: 0 }, { x: 100, y: 0 }), 1100);
    const finished: GameStateSnapshot = {
      ...movingPair({ x: 5, y: 5 }, { x: 250, y: 0 }),
      phase: "finished",
      winnerId: "p1",
    };
    expect(interpolateSnapshot(buffer, 1050, finished)).toBe(finished);
  });

  it("keeps the delay constant within the documented budget", () => {
    // Guard against accidental tuning drift: the render delay must stay a
    // small, bounded lag behind the newest arrival (spec: tolerate 40/60/80
    // ms snapshot jitter without changing server timing).
    expect(INTERPOLATION_DELAY_MS).toBeGreaterThan(20);
    expect(INTERPOLATION_DELAY_MS).toBeLessThanOrEqual(80);
  });
});
