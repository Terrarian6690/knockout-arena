import { describe, expect, it } from "vitest";
import { createArena, type GamePhase, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { Vfx, type VfxEvent } from "../effects";

/**
 * The EVENT STREAM the audio layer consumes (Task 22 "Event detection"):
 * `Vfx.observe` is the single detector, so its return value must carry
 * exactly-once semantics for every sound-producing event — duplicates,
 * re-rendered aim echoes, finished re-pushes, reconnect mounts and match
 * resets must never replay history, while genuinely new transitions must
 * keep firing. All clock-scripted, deterministic RNG, no DOM.
 */

const ARENA = createArena();
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

function aiming(): GameStateSnapshot {
  return state("aiming", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
}

const LAUNCH = { direction: { x: 1, y: 0 }, power: 3 };

function resolving(p1: Partial<PawnSnapshot> = {}): GameStateSnapshot {
  return state("moving", [
    pawnAt("p0", 300, 300, { isLocal: true, launch: LAUNCH }),
    pawnAt("p1", 500, 300, { launch: LAUNCH, ...p1 }),
  ]);
}

function typesOf(events: readonly VfxEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("audio event detection", () => {
  it("a resolving round reports round-start + one launch per revealed launch", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    const events = vfx.observe(aiming(), resolving(), 1000);
    expect(typesOf(events)).toEqual(["round-start", "launch", "launch"]);
    const launches = events.filter((e) => e.type === "launch");
    expect(launches.every((e) => e.type === "launch" && e.power === 3)).toBe(true);
  });

  it("a round with no committed launches still reports round-start", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    const noLaunch = state("moving", [pawnAt("p0", 300, 300, { isLocal: true }), pawnAt("p1", 500, 300)]);
    expect(typesOf(vfx.observe(aiming(), noLaunch, 1000))).toEqual(["round-start"]);
  });

  it("duplicate snapshots never replay the launch sound", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    vfx.observe(aiming(), resolving(), 1000);
    // moving → moving with the same launch data: silence.
    expect(vfx.observe(resolving(), resolving(), 1016)).toEqual([]);
    expect(vfx.observe(resolving(), resolving({ position: { x: 510, y: 300 } }), 1032))
      .toEqual([]);
  });

  it("aiming echoes (preview changes) produce no events", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    const a = { ...aiming(), aimDirection: { x: 0, y: 1 }, power: 5 };
    const b = { ...aiming(), aimDirection: { x: 1, y: 0 }, power: 2 };
    expect(vfx.observe(a, b, 1000)).toEqual([]);
  });

  it("the elimination event fires exactly once", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    const gone = resolving({ position: { x: 500, y: 250 }, eliminated: true });
    expect(typesOf(vfx.observe(resolving(), gone, 1000))).toEqual(["elimination"]);
    // Already-eliminated follow-ups: nothing.
    expect(
      vfx.observe(gone, resolving({ position: { x: 505, y: 250 }, eliminated: true }), 1016)
    ).toEqual([]);
  });

  it("the winner event fires exactly once, never for draws or re-pushes", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    const finished: GameStateSnapshot = {
      ...resolving(),
      phase: "finished",
      winnerId: "p1",
    };
    expect(typesOf(vfx.observe(resolving(), finished, 1000))).toEqual(["winner"]);
    // finished → finished (even with a winner present): nothing.
    expect(vfx.observe(finished, finished, 1016)).toEqual([]);
    // A draw: no winner event at all.
    const vfx2 = new Vfx({ random: rng, arena: ARENA });
    expect(
      typesOf(vfx2.observe(resolving(), { ...resolving(), phase: "finished", winnerId: null }, 1000))
    ).toEqual([]);
  });

  it("never fires events when mounting into an already-active state (reconnect)", () => {
    // Mount straight into finished + winner: no replayed history.
    const vfx = new Vfx({ random: rng, arena: ARENA });
    expect(vfx.observe(null, { ...resolving(), phase: "finished", winnerId: "p1" }, 1000)).toEqual([]);
    // Mount straight into a resolving round: no launch sound for the past.
    const vfx2 = new Vfx({ random: rng, arena: ARENA });
    expect(vfx2.observe(null, resolving(), 1000)).toEqual([]);
    // And the follow-up duplicate stays silent.
    expect(vfx2.observe(resolving(), resolving(), 1016)).toEqual([]);
  });

  it("an impact fires once with its strength, cooldown-gated like the VFX", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    const left = state("moving", [
      pawnAt("p0", 100, 100, { isLocal: true }),
      pawnAt("p1", 140, 100),
    ]);
    const touching = state("moving", [
      pawnAt("p0", 105, 100),
      pawnAt("p1", 136, 100),
    ]);
    const events = vfx.observe(left, touching, 1000);
    expect(typesOf(events)).toEqual(["impact"]);
    expect(events[0]).toMatchObject({ type: "impact", strength: 9 });
    // Still touching next tick: no second impact.
    expect(vfx.observe(touching, touching, 1016)).toEqual([]);
    // Separate + re-hit inside the cooldown: still nothing.
    const separated = state("moving", [
      pawnAt("p0", 100, 100),
      pawnAt("p1", 140, 100),
    ]);
    vfx.observe(touching, separated, 1020);
    expect(vfx.observe(separated, touching, 1030)).toEqual([]);
  });

  it("a match reset clears history: the next match's events fire normally", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    // Full old match: launch, elimination, winner.
    vfx.observe(aiming(), resolving(), 1000);
    vfx.observe(
      resolving(),
      resolving({ position: { x: 500, y: 250 }, eliminated: true }),
      1100
    );
    vfx.observe(
      resolving({ position: { x: 500, y: 250 }, eliminated: true }),
      { ...resolving(), phase: "finished", winnerId: "p1" },
      1200
    );
    // Reset: everyone alive again, back to aiming — no events for that.
    const freshAiming = aiming();
    expect(
      vfx.observe(
        { ...resolving(), phase: "finished", winnerId: "p1" },
        freshAiming,
        1300
      )
    ).toEqual([]);
    // The NEW match's transitions fire like the first one — no leaks
    // (no phantom winner, no replayed launches).
    expect(typesOf(vfx.observe(freshAiming, resolving(), 1400))).toEqual([
      "round-start",
      "launch",
      "launch",
    ]);
    expect(
      typesOf(
        vfx.observe(
          resolving(),
          { ...resolving(), phase: "finished", winnerId: "p0" },
          1500
        )
      )
    ).toEqual(["winner"]);
  });

  it("each new round reports a fresh round-start", () => {
    const vfx = new Vfx({ random: rng, arena: ARENA });
    vfx.observe(aiming(), resolving(), 1000);
    vfx.observe(resolving(), aiming(), 2000); // round 1 resolved
    expect(typesOf(vfx.observe(aiming(), resolving(), 2100))).toEqual([
      "round-start",
      "launch",
      "launch",
    ]);
  });
});
