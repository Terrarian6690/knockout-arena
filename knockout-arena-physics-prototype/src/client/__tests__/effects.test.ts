import { describe, expect, it } from "vitest";
import { createArena, type GamePhase, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { VFX, Vfx, prefersReducedMotion } from "../effects";

/**
 * The render-only VFX layer — event detection from AUTHORITATIVE
 * snapshots, bounded trail sampling, baked draw lists and screen shake.
 * Labels follow the Task 19 spec:
 *
 *   launch        once per launch, direction respected, expires,
 *                 independent pawns
 *   trails        points appear while moving, bounded, expire,
 *                 stationary pawns add nothing
 *   collision     supported transition fires once (cooldown), resting
 *                 contact and slow nudges never fire, expires
 *   elimination   once, at the authoritative position, trail dropped,
 *                 expires, shake bounded
 *   winner        only the authoritative winner, only after finished
 *   transitions   round-start once, nothing crosses a boundary,
 *                 reset clears everything
 *   reduced       no shake, ~half the particles
 *
 * Everything is clock-scripted and the RNG is pinned to a constant —
 * fully deterministic, no DOM, no timers.
 */

const ARENA = createArena();
/** Deterministic randomness (the midpoint for every draw). */
const rng = () => 0.5;

function pawnAt(
  id: string,
  x: number,
  y: number,
  overrides: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name: `Player ${id}`,
    position: { x, y },
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

function state(
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

/** A resolving round where p0 (local, at the left) and p1 move. */
function moving(
  p0: Partial<PawnSnapshot> = {},
  p1: Partial<PawnSnapshot> = {}
): GameStateSnapshot {
  return state("moving", [
    pawnAt("p0", 300, 300, { isLocal: true, ...p0 }),
    pawnAt("p1", 500, 300, { ...p1 }),
  ]);
}

function makeVfx(reduced = false): Vfx {
  return new Vfx({ random: rng, arena: ARENA, reducedMotion: reduced });
}

describe("launch effects", () => {
  const launch = { direction: { x: 1, y: 0 }, power: 3 };

  it("triggers exactly once per launch", () => {
    const vfx = makeVfx();
    const before = state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
    const start = moving({ launch }, { launch });
    vfx.observe(before, start, 1000);
    const first = vfx.buildFrame(1000);
    expect(first.particles.length).toBeGreaterThan(0);
    // A re-push of the same moving state (or an aim echo) must not
    // re-trigger anything.
    vfx.observe(start, moving({ launch }, { launch }), 1016);
    const second = vfx.buildFrame(1016);
    expect(second.particles.length).toBe(first.particles.length);
  });

  it("respects the revealed launch direction (bursts behind the pawn)", () => {
    const vfx = makeVfx();
    // p1 launches toward +x from (500, 300): the burst goes -x.
    vfx.observe(
      state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]),
      moving({}, { launch }),
      1000
    );
    const atStart = vfx.buildFrame(1000).particles;
    expect(atStart.length).toBeGreaterThan(0);
    for (const p of atStart) {
      expect(Math.abs(p.x - 500)).toBeLessThanOrEqual(20); // at the pawn
    }
    const later = vfx.buildFrame(1100).particles; // 100 ms of flight
    for (let i = 0; i < later.length; i++) {
      expect(later[i]!.x).toBeLessThan(atStart[i]!.x); // drifting backwards
    }
  });

  it("expires within the spec budget", () => {
    const vfx = makeVfx();
    vfx.observe(
      state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]),
      moving({}, { launch }),
      1000
    );
    // The same push also spawns the longer-lived round-start ring, so the
    // "nothing left" moment follows the LONGEST effect of the transition.
    const after = 1000 + Math.max(VFX.launchLife, VFX.roundStartLife) + 10;
    expect(vfx.buildFrame(after).particles).toHaveLength(0);
    expect(vfx.hasActivity(after)).toBe(false);
    expect(VFX.launchLife).toBeGreaterThanOrEqual(100);
    expect(VFX.launchLife).toBeLessThanOrEqual(250);
  });

  it("multiple pawns launch independently", () => {
    const vfx = makeVfx();
    vfx.observe(
      state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]),
      moving(
        { launch: { direction: { x: -1, y: 0 }, power: 2 } },
        { launch: { direction: { x: 1, y: 0 }, power: 5 } }
      ),
      1000
    );
    const particles = vfx.buildFrame(1000).particles;
    // One burst around EACH launching pawn (spawned at the pawn itself).
    const nearP0 = particles.filter((p) => Math.hypot(p.x - 300, p.y - 300) <= 25);
    const nearP1 = particles.filter((p) => Math.hypot(p.x - 500, p.y - 300) <= 25);
    expect(nearP0.length).toBeGreaterThan(0);
    expect(nearP1.length).toBeGreaterThan(0);
    // Higher power → visibly more particles (5 + power, capped at 12).
    expect(nearP1.length).toBeGreaterThan(nearP0.length);
  });

  it("unconfirmed pawns (no launch datum) get no burst", () => {
    const vfx = makeVfx();
    vfx.observe(
      state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]),
      moving({ launch }, { launch: null }),
      1000
    );
    const particles = vfx.buildFrame(1000).particles;
    expect(particles.filter((p) => Math.hypot(p.x - 500, p.y - 300) <= 25)).toHaveLength(0);
    expect(particles.filter((p) => Math.hypot(p.x - 300, p.y - 300) <= 25).length).toBeGreaterThan(0);
  });
});

describe("movement trails", () => {
  it("a moving pawn produces trail points", () => {
    const vfx = makeVfx();
    const visual = moving();
    vfx.sampleTrails(visual, 1000); // first sight: baseline only
    expect(vfx.buildFrame(1000).trails).toHaveLength(0);
    vfx.sampleTrails(moving({}, { position: { x: 520, y: 300 } }), 1016);
    const dots = vfx.buildFrame(1016).trails;
    expect(dots.length).toBeGreaterThan(0);
    expect(dots[0]!.x).toBe(520);
  });

  it("is bounded per pawn", () => {
    const vfx = makeVfx();
    vfx.sampleTrails(moving(), 1000); // baseline
    for (let i = 1; i <= 40; i++) {
      vfx.sampleTrails(moving({}, { position: { x: 500 + i * 10, y: 300 } }), 1000 + i * 16);
    }
    expect(vfx.buildFrame(1000 + 40 * 16).trails.length).toBeLessThanOrEqual(
      VFX.trailMaxPoints
    );
  });

  it("expires automatically", () => {
    const vfx = makeVfx();
    vfx.sampleTrails(moving(), 1000);
    vfx.sampleTrails(moving({}, { position: { x: 520, y: 300 } }), 1016);
    expect(vfx.buildFrame(1016).trails.length).toBeGreaterThan(0);
    const after = 1016 + VFX.trailLife + 10;
    expect(vfx.buildFrame(after).trails).toHaveLength(0);
    expect(vfx.hasActivity(after)).toBe(false);
  });

  it("a stationary pawn never generates points", () => {
    const vfx = makeVfx();
    const still = moving();
    for (let t = 1000; t <= 1200; t += 16) {
      vfx.sampleTrails(still, t);
    }
    expect(vfx.buildFrame(1200).trails).toHaveLength(0);
  });

  it("eliminated pawns are not trailed", () => {
    const vfx = makeVfx();
    vfx.sampleTrails(moving(), 1000);
    vfx.sampleTrails(moving({}, { position: { x: 520, y: 300 } }), 1016);
    expect(
      vfx.buildFrame(1016).trails.filter((d) => d.x >= 500).length
    ).toBeGreaterThan(0);
    // The elimination push (the real pipeline order: observe, then draw):
    // the burst handler drops the pawn's trail…
    vfx.observe(
      moving({}, { position: { x: 520, y: 300 } }),
      moving({}, { position: { x: 540, y: 300 }, eliminated: true }),
      1032
    );
    // …and an eliminated pawn never generates new points either.
    vfx.sampleTrails(moving({}, { position: { x: 560, y: 300 }, eliminated: true }), 1048);
    expect(vfx.buildFrame(1048).trails.filter((d) => d.x >= 500)).toHaveLength(0);
  });

  it("aims/finished phases sample nothing", () => {
    const vfx = makeVfx();
    vfx.sampleTrails(state("aiming", [pawnAt("p0", 300, 300)]), 1000);
    vfx.sampleTrails(state("finished", [pawnAt("p0", 300, 300)]), 1016);
    expect(vfx.buildFrame(1016).trails).toHaveLength(0);
  });
});

describe("collision effects", () => {
  // Two pawns 40 apart (radii 16+16, contact margin 3 → contact ≤ 35).
  const apart = moving(
    { position: { x: 100, y: 100 } },
    { position: { x: 140, y: 100 } }
  );
  const touching = moving(
    { position: { x: 105, y: 100 } },
    { position: { x: 136, y: 100 } }
  ); // d = 31 ≤ 35, closing 9

  it("a supported contact transition creates one impact", () => {
    const vfx = makeVfx();
    vfx.observe(apart, touching, 1000);
    const frame = vfx.buildFrame(1000);
    expect(frame.rings).toHaveLength(1);
    expect(frame.particles.length).toBeGreaterThan(0);
    // The effect sits between the two pawns, not somewhere invented.
    expect(frame.rings[0]!.x).toBeCloseTo(120.5, 5);
    expect(frame.rings[0]!.y).toBe(100);
  });

  it("does not repeat while the pawns stay in contact", () => {
    const vfx = makeVfx();
    vfx.observe(apart, touching, 1000);
    const resting = moving(
      { position: { x: 105.5, y: 100 } },
      { position: { x: 136, y: 100 } }
    );
    vfx.observe(touching, resting, 1016); // no approach → nothing
    vfx.observe(resting, resting, 1032);
    expect(vfx.buildFrame(1032).rings).toHaveLength(1); // still the first one
  });

  it("respects the per-pair cooldown on a rapid re-hit", () => {
    const vfx = makeVfx();
    vfx.observe(apart, touching, 1000);
    // They separate and slam together again within the cooldown.
    const separated = moving(
      { position: { x: 100, y: 100 } },
      { position: { x: 140, y: 100 } }
    );
    vfx.observe(touching, separated, 1010);
    vfx.observe(separated, touching, 1020);
    // Old ring expired by now, but no NEW one was allowed (cooldown).
    const frame = vfx.buildFrame(1020 + VFX.collisionLife + 10);
    expect(frame.rings).toHaveLength(0);
    expect(frame.particles).toHaveLength(0);
  });

  it("expires safely", () => {
    const vfx = makeVfx();
    vfx.observe(apart, touching, 1000);
    const after = 1000 + VFX.collisionLife + 10;
    expect(vfx.buildFrame(after).rings).toHaveLength(0);
    expect(vfx.buildFrame(after).particles).toHaveLength(0);
  });

  it("generates nothing for near-misses, slow nudges or eliminated pawns", () => {
    // Approaching but never within contact distance.
    const vfxA = makeVfx();
    vfxA.observe(
      moving({ position: { x: 100, y: 100 } }, { position: { x: 150, y: 100 } }),
      moving({ position: { x: 101, y: 100 } }, { position: { x: 149, y: 100 } }),
      1000
    );
    expect(vfxA.buildFrame(1000).rings).toHaveLength(0);

    // In contact but with a negligible approach speed.
    const vfxB = makeVfx();
    vfxB.observe(
      moving({ position: { x: 100, y: 100 } }, { position: { x: 137, y: 100 } }),
      moving({ position: { x: 100.2, y: 100 } }, { position: { x: 136.9, y: 100 } }),
      1000
    );
    expect(vfxB.buildFrame(1000).rings).toHaveLength(0);

    // An eliminated pawn can produce no collision effect.
    const vfxC = makeVfx();
    vfxC.observe(
      moving({ position: { x: 100, y: 100 } }, { position: { x: 140, y: 100 }, eliminated: true }),
      moving({ position: { x: 105, y: 100 } }, { position: { x: 136, y: 100 }, eliminated: true }),
      1000
    );
    expect(vfxC.buildFrame(1000).rings).toHaveLength(0);
    expect(vfxC.buildFrame(1000).particles).toHaveLength(0);
  });

  it("only fires while the round is actually resolving", () => {
    // The aiming → moving transition push itself must not double as a
    // collision (both snapshots must already be in "moving"): the only
    // ring from that push is the round-start pulse at the arena center.
    const vfx = makeVfx();
    const aiming = state("aiming", [
      pawnAt("p0", 100, 100, { isLocal: true }),
      pawnAt("p1", 140, 100),
    ]);
    vfx.observe(aiming, touching, 1000);
    const rings = vfx.buildFrame(1000).rings;
    expect(rings.filter((r) => r.x === ARENA.centerX)).toHaveLength(1);
    expect(rings.filter((r) => Math.abs(r.x - 120.5) < 1)).toHaveLength(0);
  });
});

describe("elimination effects", () => {
  const alive = moving();
  const gone = moving({}, { position: { x: 500, y: 250 }, eliminated: true });

  it("triggers exactly once, at the authoritative position", () => {
    const vfx = makeVfx();
    vfx.observe(alive, gone, 1000);
    const frame = vfx.buildFrame(1000);
    expect(frame.particles.length).toBeGreaterThan(0);
    expect(frame.rings).toHaveLength(1);
    // Every particle and the ring start AT the authoritative spot.
    expect(frame.rings[0]!.x).toBe(500);
    expect(frame.rings[0]!.y).toBe(250);
    for (const p of frame.particles) {
      expect(Math.hypot(p.x - 500, p.y - 250)).toBeLessThanOrEqual(20);
    }
    // The already-eliminated follow-up push adds nothing.
    vfx.observe(gone, moving({}, { position: { x: 505, y: 250 }, eliminated: true }), 1016);
    expect(vfx.buildFrame(1016).particles.length).toBe(frame.particles.length);
  });

  it("drops the eliminated pawn's trail (no ghost motion)", () => {
    const vfx = makeVfx();
    vfx.sampleTrails(moving(), 1000);
    vfx.sampleTrails(moving({}, { position: { x: 520, y: 300 } }), 1016);
    vfx.observe(moving({}, { position: { x: 520, y: 300 } }), gone, 1032);
    const dots = vfx.buildFrame(1032).trails;
    expect(dots.filter((d) => d.x > 450)).toHaveLength(0);
  });

  it("expires and the shake decays within its budget", () => {
    const vfx = makeVfx();
    vfx.observe(alive, gone, 1000);
    expect(vfx.shakeOffset(1000 + 100)).not.toEqual({ x: 0, y: 0 });
    expect(vfx.shakeOffset(1000 + 210)).toEqual({ x: 0, y: 0 });
    const after = 1000 + VFX.eliminationLife + 10;
    expect(vfx.buildFrame(after).particles).toHaveLength(0);
    expect(vfx.buildFrame(after).rings).toHaveLength(0);
    expect(VFX.eliminationLife).toBeGreaterThanOrEqual(300);
    expect(VFX.eliminationLife).toBeLessThanOrEqual(600);
  });

  it("keeps the shake amplitude bounded", () => {
    const vfx = makeVfx();
    vfx.observe(alive, gone, 1000);
    for (let t = 1000; t <= 1200; t += 7) {
      const s = vfx.shakeOffset(t);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(VFX.shakeMax);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(VFX.shakeMax);
    }
  });
});

describe("winner effects", () => {
  const resolving = moving();
  const finishedP1: GameStateSnapshot = {
    ...moving({}, { position: { x: 500, y: 250 } }),
    phase: "finished",
    winnerId: "p1",
  };

  it("celebrates exactly the authoritative winner", () => {
    const vfx = makeVfx();
    vfx.observe(resolving, finishedP1, 1000);
    const particles = vfx.buildFrame(1000).particles;
    expect(particles.length).toBeGreaterThan(0);
    // All celebration particles originate AT the winner (p1 at 500,250) —
    // the loser (p0 at 300,300) gets nothing.
    for (const p of particles) {
      expect(Math.hypot(p.x - 500, p.y - 250)).toBeLessThanOrEqual(2);
    }
  });

  it("does not fire before the finished phase or without a winner", () => {
    const vfx = makeVfx();
    // Still resolving: no celebration even if a crafted snapshot leaks a
    // winnerId outside the finished phase.
    vfx.observe(resolving, { ...moving(), winnerId: "p1" }, 1000);
    const frame = vfx.buildFrame(1000);
    expect(
      frame.particles.filter((p) => Math.hypot(p.x - 500, p.y - 250) <= 2)
    ).toHaveLength(0);
    // Finished but a draw (no winner): nothing either.
    const vfx2 = makeVfx();
    vfx2.observe(resolving, { ...finishedP1, winnerId: null }, 1000);
    expect(vfx2.buildFrame(1000).particles).toHaveLength(0);
    // Mounting straight into finished: no fireworks for a joiner.
    const vfx3 = makeVfx();
    vfx3.observe(null, finishedP1, 1000);
    expect(vfx3.buildFrame(1000).particles).toHaveLength(0);
  });
});

describe("round transitions", () => {
  const launch = { direction: { x: 1, y: 0 }, power: 3 };

  it("the round-start pulse fires once per aiming → moving", () => {
    const vfx = makeVfx();
    const before = state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
    vfx.observe(before, moving({ launch }, { launch }), 1000);
    // One center ring (round start) + the launch bursts.
    const frame = vfx.buildFrame(1000);
    const centerRings = frame.rings.filter(
      (r) => r.x === ARENA.centerX && r.y === ARENA.centerY
    );
    expect(centerRings).toHaveLength(1);
    // A re-push of the same moving state adds no second pulse.
    vfx.observe(moving({ launch }, { launch }), moving({ launch }, { launch }), 1016);
    const again = vfx.buildFrame(1016).rings.filter(
      (r) => r.x === ARENA.centerX && r.y === ARENA.centerY
    );
    expect(again).toHaveLength(1);
  });

  it("nothing crosses a round boundary", () => {
    const vfx = makeVfx();
    const before = state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
    vfx.observe(before, moving({ launch }, { launch }), 1000);
    expect(vfx.buildFrame(1000).particles.length).toBeGreaterThan(0);
    // The round resolves → back to aiming: every transient effect is gone
    // immediately (well inside their natural lifetimes).
    vfx.observe(
      moving({ launch }, { launch }),
      state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]),
      1050
    );
    const frame = vfx.buildFrame(1050);
    expect(frame.particles).toHaveLength(0);
    expect(frame.rings).toHaveLength(0);
    expect(frame.trails).toHaveLength(0);
    expect(vfx.shakeOffset(1050)).toEqual({ x: 0, y: 0 });
  });

  it("a match reset (pawn revival) clears transient effects", () => {
    const vfx = makeVfx();
    const before = state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
    vfx.observe(before, moving({ launch }, { launch }), 1000);
    vfx.observe(
      moving({ launch }, { launch }),
      moving({ launch }, { launch, position: { x: 550, y: 300 }, eliminated: true }),
      1050
    );
    expect(vfx.buildFrame(1050).particles.length).toBeGreaterThan(0); // elimination burst
    // Reset: everyone alive again (engine reset mid-match).
    vfx.observe(
      moving({ launch }, { launch, position: { x: 550, y: 300 }, eliminated: true }),
      moving({}, {}),
      1100
    );
    const frame = vfx.buildFrame(1100);
    expect(frame.particles).toHaveLength(0);
    expect(frame.rings).toHaveLength(0);
  });
});

describe("reduced motion", () => {
  const alive = moving();
  const gone = moving({}, { position: { x: 500, y: 250 }, eliminated: true });

  it("disables screen shake entirely", () => {
    const vfx = makeVfx(true);
    vfx.observe(alive, gone, 1000);
    for (let t = 1000; t <= 1200; t += 7) {
      expect(vfx.shakeOffset(t)).toEqual({ x: 0, y: 0 });
    }
  });

  it("roughly halves particle counts", () => {
    const full = makeVfx(false);
    const reduced = makeVfx(true);
    full.observe(alive, gone, 1000);
    reduced.observe(alive, gone, 1000);
    const a = full.buildFrame(1000).particles.length;
    const b = reduced.buildFrame(1000).particles.length;
    expect(a).toBe(20);
    expect(b).toBe(10);
    expect(b).toBeLessThan(a);
  });

  it("keeps the winner celebration (state communication) but smaller", () => {
    const vfx = makeVfx(true);
    vfx.observe(
      moving(),
      { ...moving({}, { position: { x: 500, y: 250 } }), phase: "finished", winnerId: "p1" },
      1000
    );
    const particles = vfx.buildFrame(1000).particles;
    expect(particles.length).toBeGreaterThan(0);
    expect(particles.length).toBeLessThan(26);
  });

  it("prefersReducedMotion defaults to full motion without matchMedia", () => {
    // Node has no window — the guard must degrade to false, never throw.
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("bounds", () => {
  it("caps the global particle count", () => {
    const vfx = makeVfx();
    // Six pawns knocked out at once: 6 × 20 = 120 > the global cap.
    const pawns = Array.from({ length: 6 }, (_, i) =>
      pawnAt(`p${i}`, 100 + i * 100, 100, { eliminated: i > 0 })
    );
    const before: GameStateSnapshot = {
      ...state("moving", pawns.map((p) => ({ ...p, eliminated: false }))),
    };
    const after = state("moving", pawns);
    vfx.observe(before, after, 1000);
    expect(vfx.buildFrame(1000).particles.length).toBeLessThanOrEqual(VFX.maxParticles);
  });

  it("never leaks activity after everything expired", () => {
    const vfx = makeVfx();
    const before = state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
    vfx.observe(before, moving({ launch: { direction: { x: 1, y: 0 }, power: 5 } }, { launch: { direction: { x: -1, y: 0 }, power: 5 } }), 1000);
    vfx.observe(moving({}, {}), moving({}, { position: { x: 500, y: 250 }, eliminated: true }), 1200);
    const after = 1200 + VFX.eliminationLife + VFX.winnerBurstLife + 100;
    expect(vfx.hasActivity(after)).toBe(false);
    const frame = vfx.buildFrame(after);
    expect(frame.particles).toHaveLength(0);
    expect(frame.rings).toHaveLength(0);
    expect(frame.trails).toHaveLength(0);
  });
});
