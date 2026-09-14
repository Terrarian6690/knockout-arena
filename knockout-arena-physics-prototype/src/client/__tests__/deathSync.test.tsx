// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GameStateSnapshot, PawnSnapshot } from "../../game";
import { MatchRail } from "../components/game/MatchRail";
import {
  describedPawn,
  seatDescription,
} from "../components/game/arenaDescription";
import {
  eliminationAnnouncement,
  newlyEliminated,
} from "../components/game/matchAnnouncements";
import {
  DEATH_DRIFT_FRACTION,
  INTERPOLATION_DELAY_MS,
  SnapshotBuffer,
  interpolateSnapshot,
} from "../interpolation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(cleanup);

/**
 * DEATH SYNC (Task 24).
 *
 * Task 23 established the elimination BOUNDARY is correct (a pawn dies
 * only once fully past floor + pawnRadius) and diagnosed why it could
 * still look early: remote pawns are drawn INTERPOLATION_DELAY_MS in the
 * past, while `eliminated` was read from the newest snapshot. At power 5
 * that gap is ~32 units — a whole pawn diameter — so the pawn turned red
 * while still drawn inside the floor.
 *
 * The fix is presentation-only: the elimination FLAG now travels on the
 * same delayed timeline as the POSITION. Nothing authoritative moved.
 *
 * Pinned here:
 *   1  a remote death is shown when the body arrives, not when reported
 *   2  the local pawn is exempt (it is never interpolated, so never lags)
 *   3  roster / announcements / arena description stay IMMEDIATE
 *   4  the cosmetic coast never contradicts authoritative motion
 */

const CENTER_X = 450;
const CENTER_Y = 350;

function pawn(
  id: string,
  position: { x: number; y: number },
  over: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name: `Player ${id}`,
    position,
    velocity: { x: 0, y: 0 },
    radius: 16,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: false,
    colorIndex: 0,
    ...over,
  };
}

function moving(pawns: PawnSnapshot[]): GameStateSnapshot {
  return {
    phase: "moving",
    pawns,
    localPawnId: "p0",
    isAiming: false,
    aimDirection: null,
    power: 3,
    winnerId: null,
    round: 1,
    arena: { centerX: CENTER_X, centerY: CENTER_Y, radius: 330, wallThickness: 16 },
  } as unknown as GameStateSnapshot;
}

/** A pair of pushes 100 ms apart in which p1 flies out and dies. */
function knockoutBuffer(deathAt: { x: number; y: number }) {
  const buffer = new SnapshotBuffer();
  buffer.push(
    moving([
      pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
      pawn("p1", { x: CENTER_X, y: CENTER_Y }),
    ]),
    1000
  );
  const latest = moving([
    pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
    pawn("p1", deathAt, { eliminated: true }),
  ]);
  buffer.push(latest, 1100);
  return { buffer, latest };
}

describe("a remote death is shown where the body is", () => {
  it("keeps the pawn alive on screen until it reaches the death point", () => {
    // The pawn dies 330 units out (the true boundary from Task 23).
    const { buffer, latest } = knockoutBuffer({ x: CENTER_X + 330, y: CENTER_Y });

    // Authoritative: dead from the moment the push landed.
    expect(latest.pawns.find((p) => p.id === "p1")!.eliminated).toBe(true);

    // On the delayed timeline it is still travelling — and still ALIVE,
    // so the renderer draws no red tint yet.
    for (const [renderTime, expectedX] of [
      [1025, CENTER_X + 82.5],
      [1050, CENTER_X + 165],
      [1075, CENTER_X + 247.5],
    ] as const) {
      const visual = interpolateSnapshot(buffer, renderTime, latest);
      const p1 = visual.pawns.find((p) => p.id === "p1")!;
      expect(p1.position.x).toBeCloseTo(expectedX, 6);
      expect(p1.eliminated).toBe(false);
    }

    // Arrival: shown dead, at exactly the authoritative death position.
    const arrived = interpolateSnapshot(buffer, 1100, latest);
    const dead = arrived.pawns.find((p) => p.id === "p1")!;
    expect(dead.position.x).toBeCloseTo(CENTER_X + 330, 6);
    expect(dead.eliminated).toBe(true);
  });

  it("never shows the death while the body is still inside the floor", () => {
    // The regression in one assertion. Floor edge is 314; the pawn dies
    // at 330. Anywhere the drawn body is still short of 330, it must not
    // be tinted — previously it was tinted at ~298, inside the floor.
    const { buffer, latest } = knockoutBuffer({ x: CENTER_X + 330, y: CENTER_Y });
    for (let renderTime = 1000; renderTime < 1100; renderTime += 5) {
      const visual = interpolateSnapshot(buffer, renderTime, latest);
      const p1 = visual.pawns.find((p) => p.id === "p1")!;
      const distance = p1.position.x - CENTER_X;
      if (p1.eliminated) {
        expect(distance).toBeGreaterThanOrEqual(330);
      }
    }
  });

  it("still lands the death exactly one interpolation delay late", () => {
    // The delay is the whole point: the visual is late by precisely the
    // amount the position is late, so the two agree.
    const { buffer, latest } = knockoutBuffer({ x: CENTER_X + 330, y: CENTER_Y });
    const reportedAt = 1100;
    const shownAt = reportedAt; // render time at which the flag flips
    const visual = interpolateSnapshot(buffer, shownAt, latest);
    expect(visual.pawns.find((p) => p.id === "p1")!.eliminated).toBe(true);
    const justBefore = interpolateSnapshot(buffer, shownAt - 1, latest);
    expect(justBefore.pawns.find((p) => p.id === "p1")!.eliminated).toBe(false);
    // And in wall-clock terms that is the interpolation delay behind the
    // push, because the renderer always draws at now - delay.
    expect(INTERPOLATION_DELAY_MS).toBe(50);
  });
});

describe("the local pawn is exempt — it never lagged", () => {
  it("shows the local player's own death immediately", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(
      moving([
        pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
        pawn("p1", { x: CENTER_X + 50, y: CENTER_Y }),
      ]),
      1000
    );
    const latest = moving([
      pawn("p0", { x: CENTER_X + 330, y: CENTER_Y }, { isLocal: true, eliminated: true }),
      pawn("p1", { x: CENTER_X + 60, y: CENTER_Y }),
    ]);
    buffer.push(latest, 1100);

    // Mid-pair: the REMOTE pawn is interpolated (it lags)…
    const visual = interpolateSnapshot(buffer, 1050, latest);
    expect(visual.pawns.find((p) => p.id === "p1")!.position.x).toBeCloseTo(
      CENTER_X + 55,
      6
    );
    // …but the LOCAL pawn is not interpolated at all, so its death has no
    // lag to compensate and is shown at once, at its authoritative spot.
    const local = visual.pawns.find((p) => p.id === "p0")!;
    expect(local.eliminated).toBe(true);
    expect(local.position.x).toBe(CENTER_X + 330);
  });
});

describe("authoritative consumers stay immediate", () => {
  const authoritative = moving([
    pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
    pawn("p1", { x: CENTER_X + 330, y: CENTER_Y }, { eliminated: true }),
  ]);

  it("the roster shows the knockout at once (not delayed)", () => {
    render(<MatchRail snapshot={authoritative} hostPlayerId="p0" />);
    const row = screen.getByTestId("rail-p1");
    expect(row.className).toContain("opacity-45"); // the eliminated styling
  });

  it("announcements fire from the authoritative state (Task 10 intact)", () => {
    const before = moving([
      pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
      pawn("p1", { x: CENTER_X + 300, y: CENTER_Y }),
    ]);
    const gone = newlyEliminated(before, authoritative);
    expect(gone.map((p) => p.id)).toEqual(["p1"]);
    expect(eliminationAnnouncement(before, authoritative, "p0")).toMatch(
      /knocked out|eliminated|out/i
    );
  });

  it("the arena description reports the knockout immediately", () => {
    const p1 = authoritative.pawns.find((p) => p.id === "p1")!;
    expect(seatDescription(describedPawn(p1), "p0")).toMatch(/knocked out/i);
  });

  it("none of them are routed through the interpolated snapshot", () => {
    // The delay lives in ONE place. If a future change fed the visual
    // snapshot to the roster, the roster would start lying for 50 ms.
    const buffer = new SnapshotBuffer();
    buffer.push(
      moving([
        pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
        pawn("p1", { x: CENTER_X, y: CENTER_Y }),
      ]),
      1000
    );
    buffer.push(authoritative, 1100);
    const visual = interpolateSnapshot(buffer, 1050, authoritative);

    // The visual disagrees with the authoritative state right now…
    expect(visual.pawns.find((p) => p.id === "p1")!.eliminated).toBe(false);
    // …and that disagreement must never reach the roster, which renders
    // from the authoritative snapshot it is handed.
    render(<MatchRail snapshot={authoritative} hostPlayerId="p0" />);
    expect(screen.getByTestId("rail-p1").className).toContain("opacity-45");
  });
});

describe("the cosmetic coast", () => {
  it("never overrides real authoritative motion", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(
      moving([
        pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
        pawn("p1", { x: 0, y: 0 }, { eliminated: true }),
      ]),
      1000
    );
    const latest = moving([
      pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
      pawn("p1", { x: 100, y: 0 }, { eliminated: true }),
    ]);
    buffer.push(latest, 1100);
    const visual = interpolateSnapshot(buffer, 1050, latest);
    // Real motion between the pair wins: a plain lerp, no invented drift.
    expect(visual.pawns.find((p) => p.id === "p1")!.position).toEqual({
      x: 50,
      y: 0,
    });
  });

  it("stays put for a frozen pawn with no launch heading", () => {
    const frozen = pawn("p1", { x: 100, y: 0 }, { eliminated: true });
    const buffer = new SnapshotBuffer();
    buffer.push(
      moving([pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }), frozen]),
      1000
    );
    const latest = moving([
      pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
      frozen,
    ]);
    buffer.push(latest, 1100);
    const visual = interpolateSnapshot(buffer, 1050, latest);
    expect(visual.pawns.find((p) => p.id === "p1")!.position).toEqual({
      x: 100,
      y: 0,
    });
  });

  it("coasts a frozen pawn along the heading it died on, and only a little", () => {
    const heading = { x: 1, y: 0 };
    const frozen = pawn(
      "p1",
      { x: 100, y: 0 },
      { eliminated: true, launch: { direction: heading, power: 5 } }
    );
    const buffer = new SnapshotBuffer();
    buffer.push(
      moving([pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }), frozen]),
      1000
    );
    const latest = moving([
      pawn("p0", { x: CENTER_X, y: CENTER_Y }, { isLocal: true }),
      frozen,
    ]);
    buffer.push(latest, 1100);

    const mid = interpolateSnapshot(buffer, 1050, latest);
    const drifted = mid.pawns.find((p) => p.id === "p1")!;
    expect(drifted.position.x).toBeGreaterThan(100); // it kept moving
    expect(drifted.eliminated).toBe(true); // while dead
    // Bounded: never more than a fraction of one radius.
    const maxDrift = 16 * DEATH_DRIFT_FRACTION;
    expect(drifted.position.x - 100).toBeLessThanOrEqual(maxDrift);
    expect(drifted.position.y).toBe(0); // strictly along the heading
  });
});
