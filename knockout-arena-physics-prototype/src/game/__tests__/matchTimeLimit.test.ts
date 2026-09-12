import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { createArena, floorRadius } from "../arena";
import { createGame, type GameHandle } from "../game";
import { projectSnapshot } from "../project";
import { validateCommand } from "../commands";
import {
  deserializeGameState,
  serializeGameState,
  type GameState,
  type PawnState,
} from "../state";

/**
 * THE MATCH TIME LIMIT — engine half (Task 6).
 *
 * The engine owns no clock: the limit reaches it as the match-level
 * `timeUp` command, and everything the engine does with it must be
 * deterministic, phase-agnostic and expressible in the EXISTING
 * "finished" phase. These tests pin exactly that:
 *
 *   - `timeUp` finishes the match from ANY live phase (aiming, moving,
 *     between rounds) without inventing a phase;
 *   - the verdict: single survivor wins; several survivors are decided
 *     by the documented tie-break (closest to the arena center, ties by
 *     roster order); nobody alive → no winner;
 *   - a match that already finished is never finished twice;
 *   - the shrink schedule is untouched by the timeout;
 *   - the resulting state serializes/round-trips like any other finish.
 *
 * The SERVER half (when the command is submitted, the 4-minute clock,
 * deadline ordering) lives in src/server/__tests__/matchTimeLimit.test.ts.
 */

const DT = CONFIG.simulation.fixedTimestepMs;
const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;
const PAWN_R = CONFIG.pawn.radius;

function specs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    colorIndex: i,
  }));
}

function pawnAt(
  id: string,
  x: number,
  y: number,
  overrides: Partial<PawnState> = {}
): PawnState {
  return {
    id,
    name: id.toUpperCase(),
    colorIndex: Number(id.slice(1)) || 0,
    radius: PAWN_R,
    spawnX: x,
    spawnY: y,
    eliminated: false,
    power: 3,
    aim: { active: false, direction: { x: 0, y: -1 } },
    confirmed: false,
    lastLaunch: null,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    angle: 0,
    angularVelocity: 0,
    ...overrides,
  };
}

function matchState(
  pawns: PawnState[],
  opts: {
    phase?: GameState["phase"];
    radius?: number;
    roundsSinceShrink?: number;
  } = {}
): GameState {
  return {
    phase: opts.phase ?? "aiming",
    winnerId: null,
    round: { settleTicks: 0 },
    arena: {
      radius: opts.radius ?? CONFIG.arena.radius,
      roundsSinceShrink: opts.roundsSinceShrink ?? 0,
    },
    pawns,
  };
}

/** Complete a round in which nobody moves. */
function playEmptyRound(g: GameHandle): void {
  g.applyCommand({ type: "resolveRound" });
  let guard = 0;
  while (g.getState().phase === "moving" && guard++ < 5000) g.update(DT);
}

describe("the timeUp command (structure + ownership shape)", () => {
  it("is a structurally valid, player-less match-level command", () => {
    expect(validateCommand({ type: "timeUp" })).toEqual({ ok: true });
    // Like resolveRound/reset it carries no playerId — a stray one is
    // simply ignored, never treated as authority to act for someone.
    expect(validateCommand({ type: "timeUp", playerId: "p3" })).toEqual({
      ok: true,
    });
  });
});

describe("timeUp finishes the match from any live phase", () => {
  it("ends a match that is in the AIMING phase", () => {
    const g = createGame({ players: specs(2) });
    expect(g.getState().phase).toBe("aiming");
    expect(g.applyCommand({ type: "timeUp" })).toEqual({ ok: true });
    expect(g.getState().phase).toBe("finished");
    g.destroy();
  });

  it("ends a match while a round is RESOLVING (mid-flight)", () => {
    const g = createGame({ players: specs(2) });
    g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY });
    g.applyCommand({ type: "setPower", playerId: "p0", power: 4 });
    g.applyCommand({ type: "confirmLaunch", playerId: "p0" });
    g.applyCommand({ type: "resolveRound" });
    expect(g.getState().phase).toBe("moving");
    for (let i = 0; i < 5; i++) g.update(DT); // genuinely mid-flight
    expect(
      g.getState().pawns.some((p) => Math.hypot(p.velocity.x, p.velocity.y) > 0)
    ).toBe(true);

    expect(g.applyCommand({ type: "timeUp" })).toEqual({ ok: true });
    const s = g.getState();
    expect(s.phase).toBe("finished");
    // Everyone is brought to the canonical resting state, exactly like
    // any other finish — no pawn is left drifting in a finished match.
    for (const p of s.pawns) {
      if (p.eliminated) continue;
      expect(Math.hypot(p.velocity.x, p.velocity.y)).toBe(0);
    }
    g.destroy();
  });

  it("ends a match cleanly right AFTER a round resolved (between rounds)", () => {
    const g = createGame({ players: specs(2) });
    playEmptyRound(g);
    const between = g.getState();
    expect(between.phase).toBe("aiming"); // the next round just opened

    g.applyCommand({ type: "timeUp" });
    const s = g.getState();
    expect(s.phase).toBe("finished");
    // The completed round's outcome is untouched: same positions.
    expect(s.pawns.map((p) => p.position)).toEqual(
      between.pawns.map((p) => p.position)
    );
    g.destroy();
  });

  it("uses the EXISTING finished phase — no new phase is introduced", () => {
    const g = createGame({ players: specs(3) });
    g.applyCommand({ type: "timeUp" });
    expect(["aiming", "moving", "finished"]).toContain(g.getState().phase);
    expect(g.getState().phase).toBe("finished");
    // …and the finished phase behaves as it always has: actions are
    // refused, only a reset is accepted.
    expect(g.applyCommand({ type: "aim", playerId: "p0", x: CX, y: CY })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.applyCommand({ type: "reset" })).toEqual({ ok: true });
    g.destroy();
  });
});

describe("the time-limit verdict", () => {
  it("gives the win to the SINGLE survivor", () => {
    const g = createGame({ players: specs(3) });
    // p0 and p2 are already out; p1 is the only one left.
    g.loadState(
      matchState([
        pawnAt("p0", CX - 50, CY, { eliminated: true }),
        pawnAt("p1", CX + 120, CY),
        pawnAt("p2", CX, CY - 50, { eliminated: true }),
      ])
    );
    g.applyCommand({ type: "timeUp" });
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBe("p1");
    g.destroy();
  });

  it("TIE-BREAK: with several alive, the pawn closest to the center wins", () => {
    const g = createGame({ players: specs(4) });
    g.loadState(
      matchState([
        pawnAt("p0", CX + 200, CY), // 200 from center
        pawnAt("p1", CX, CY - 40), //  40 — the closest
        pawnAt("p2", CX - 120, CY), // 120
        pawnAt("p3", CX, CY + 260), // 260
      ])
    );
    g.applyCommand({ type: "timeUp" });
    expect(g.getState().winnerId).toBe("p1");
    g.destroy();
  });

  it("TIE-BREAK: measures the true radial distance, not one axis", () => {
    const g = createGame({ players: specs(2) });
    g.loadState(
      matchState([
        // p0 is nearer on x alone, but farther overall (3-4-5 triangle).
        pawnAt("p0", CX + 30, CY + 40), // hypot 50
        pawnAt("p1", CX + 45, CY), // hypot 45 — actually closer
      ])
    );
    g.applyCommand({ type: "timeUp" });
    expect(g.getState().winnerId).toBe("p1");
    g.destroy();
  });

  it("TIE-BREAK: an exact distance tie falls back to ROSTER ORDER", () => {
    const g = createGame({ players: specs(3) });
    // All three exactly 100 from the center: the earliest seat wins.
    g.loadState(
      matchState([
        pawnAt("p0", CX + 100, CY),
        pawnAt("p1", CX - 100, CY),
        pawnAt("p2", CX, CY + 100),
      ])
    );
    g.applyCommand({ type: "timeUp" });
    expect(g.getState().winnerId).toBe("p0");
    g.destroy();
  });

  it("TIE-BREAK: ignores eliminated pawns, however central they lie", () => {
    const g = createGame({ players: specs(3) });
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY, { eliminated: true }), // dead centre, but OUT
        pawnAt("p1", CX + 150, CY),
        pawnAt("p2", CX + 90, CY),
      ])
    );
    g.applyCommand({ type: "timeUp" });
    expect(g.getState().winnerId).toBe("p2"); // closest ALIVE pawn
    g.destroy();
  });

  it("is deterministic: the same state always yields the same winner", () => {
    const build = () => {
      const g = createGame({ players: specs(4) });
      g.loadState(
        matchState([
          pawnAt("p0", CX + 61, CY + 17),
          pawnAt("p1", CX - 58, CY - 23),
          pawnAt("p2", CX + 12, CY + 62),
          pawnAt("p3", CX - 44, CY + 44),
        ])
      );
      return g;
    };
    const winners = new Set<string | null>();
    for (let i = 0; i < 5; i++) {
      const g = build();
      g.applyCommand({ type: "timeUp" });
      winners.add(g.getState().winnerId);
      g.destroy();
    }
    // Distances are deliberately within ~1 unit of each other
    // (63.32 / 62.39 / 63.15 / 62.23) — the verdict must still be the
    // exact nearest pawn, every single time.
    expect(winners.size).toBe(1);
    expect([...winners][0]).toBe("p3");
  });

  it("finishes with NO winner when nobody is alive", () => {
    const g = createGame({ players: specs(2) });
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY, { eliminated: true }),
        pawnAt("p1", CX + 10, CY, { eliminated: true }),
      ])
    );
    g.applyCommand({ type: "timeUp" });
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.winnerId).toBeNull();
    g.destroy();
  });

  it("produces a winner the state validator accepts (an alive, known pawn)", () => {
    const g = createGame({ players: specs(3) });
    g.applyCommand({ type: "timeUp" });
    const s = g.getState();
    const winner = s.pawns.find((p) => p.id === s.winnerId);
    expect(winner).toBeDefined();
    expect(winner!.eliminated).toBe(false);
    // Round-trips through the serialization boundary like any finish.
    expect(deserializeGameState(serializeGameState(s))).toEqual(s);
    g.destroy();
  });
});

describe("a match that already finished is never finished again", () => {
  it("rejects timeUp after a NATURAL winner was decided", () => {
    const g = createGame({ players: specs(2) });
    // p1 is knocked out naturally: p0 wins before any time limit.
    g.loadState(
      matchState([
        pawnAt("p0", CX, CY),
        pawnAt("p1", CX, CY + 500, { eliminated: true }),
      ])
    );
    playEmptyRound(g);
    const natural = g.getState();
    expect(natural.phase).toBe("finished");
    expect(natural.winnerId).toBe("p0");

    // The clock runs out later: refused, and nothing changes.
    expect(g.applyCommand({ type: "timeUp" })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.getState()).toEqual(natural);
    g.destroy();
  });

  it("rejects a SECOND timeUp (no duplicate finish, no re-verdict)", () => {
    const g = createGame({ players: specs(3) });
    expect(g.applyCommand({ type: "timeUp" })).toEqual({ ok: true });
    const first = g.getState();
    expect(g.applyCommand({ type: "timeUp" })).toEqual({
      ok: false,
      reason: "wrong-phase",
    });
    expect(g.getState()).toEqual(first);
    g.destroy();
  });

  it("emits exactly one state change for the finish", () => {
    const g = createGame({ players: specs(2) });
    const states: GameState[] = [];
    const unsubscribe = g.subscribe((s) => states.push(s));
    const before = states.length;
    g.applyCommand({ type: "timeUp" });
    expect(states.length).toBe(before + 1);
    g.applyCommand({ type: "timeUp" }); // rejected: no emission
    expect(states.length).toBe(before + 1);
    unsubscribe();
    g.destroy();
  });
});

describe("interaction with the shrinking arena", () => {
  it("does not reset or advance the shrink schedule", () => {
    const g = createGame({ players: specs(2) });
    playEmptyRound(g);
    playEmptyRound(g); // 2 of 3 rounds towards a shrink
    const before = g.getState().arena;
    expect(before).toEqual({
      radius: CONFIG.arena.radius,
      roundsSinceShrink: 2,
    });

    g.applyCommand({ type: "timeUp" });
    // The arena state is carried into the finished state untouched.
    expect(g.getState().arena).toEqual(before);
    g.destroy();
  });

  it("keeps the shrunken radius when the limit hits late in a match", () => {
    const g = createGame({ players: specs(2) });
    const shrunk = CONFIG.arena.radius - CONFIG.arena.shrink.amount * 2;
    g.loadState(
      matchState([pawnAt("p0", CX - 40, CY), pawnAt("p1", CX + 40, CY)], {
        radius: shrunk,
        roundsSinceShrink: 1,
      })
    );
    g.applyCommand({ type: "timeUp" });
    const s = g.getState();
    expect(s.phase).toBe("finished");
    expect(s.arena).toEqual({ radius: shrunk, roundsSinceShrink: 1 });
    // …and the projection still reports that shrunken arena to clients.
    expect(projectSnapshot(s, "p0").arena!.radius).toBe(shrunk);
    g.destroy();
  });

  it("judges the tie-break against the CURRENT (shrunken) arena's center", () => {
    // The center never moves when the arena shrinks, so the rule needs no
    // adjustment — pinned here so a future re-centering cannot silently
    // change who wins.
    const g = createGame({ players: specs(2) });
    const small = CONFIG.arena.shrink.minRadius;
    const edge = floorRadius(createArena(small)) - PAWN_R - 1;
    g.loadState(
      matchState([pawnAt("p0", CX, CY + edge), pawnAt("p1", CX, CY + 20)], {
        radius: small,
      })
    );
    g.applyCommand({ type: "timeUp" });
    expect(g.getState().winnerId).toBe("p1"); // the central one
    g.destroy();
  });
});

describe("reset after a time-limit finish", () => {
  it("starts a completely fresh match", () => {
    const g = createGame({ players: specs(2) });
    playEmptyRound(g);
    g.applyCommand({ type: "timeUp" });
    expect(g.getState().phase).toBe("finished");

    g.applyCommand({ type: "reset" });
    const s = g.getState();
    expect(s.phase).toBe("aiming");
    expect(s.winnerId).toBeNull();
    expect(s.arena).toEqual({
      radius: CONFIG.arena.radius,
      roundsSinceShrink: 0,
    });
    expect(s.pawns.every((p) => !p.eliminated)).toBe(true);
    g.destroy();
  });
});
