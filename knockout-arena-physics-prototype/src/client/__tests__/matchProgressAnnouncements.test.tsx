// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { MatchProgressAnnouncer } from "../components/game/MatchProgressAnnouncer";
import {
  ANNOUNCEMENT_PAWN_FIELDS,
  eliminationAnnouncement,
  matchProgressAnnouncement,
  newlyEliminated,
  roundAnnouncement,
} from "../components/game/matchAnnouncements";

/**
 * MID-MATCH ANNOUNCEMENTS (Task 10): eliminations and round transitions.
 *
 * Two layers are pinned here:
 *   - the pure sentence builders (what is said, and from which
 *     authoritative facts);
 *   - the live region that speaks them (semantics, post-mount
 *     publication, and no repeats on duplicate snapshots).
 */

const MAX = CONFIG.match.maxPlayers;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pawn(slot: number, overrides: Partial<PawnSnapshot> = {}): PawnSnapshot {
  return {
    id: `p${slot}`,
    name: `Player ${slot + 1}`,
    position: { x: 100 + slot * 10, y: 100 },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: slot === 0,
    colorIndex: slot,
    ...overrides,
  };
}

function arenaAt(radius: number) {
  const atMin = radius <= CONFIG.arena.shrink.minRadius;
  return {
    radius,
    roundsUntilShrink: atMin ? null : CONFIG.arena.shrink.everyRounds,
    nextRadius: atMin ? null : radius - CONFIG.arena.shrink.amount,
    shrinkWarning: false,
    atMinRadius: atMin,
  };
}

function snap(options: {
  round?: number;
  radius?: number;
  eliminated?: number[];
  phase?: GameStateSnapshot["phase"];
  count?: number;
  localPawnId?: string | null;
} = {}): GameStateSnapshot {
  const count = options.count ?? MAX;
  const out = new Set(options.eliminated ?? []);
  return {
    phase: options.phase ?? "aiming",
    pawns: Array.from({ length: count }, (_, i) =>
      pawn(i, { eliminated: out.has(i) })
    ),
    localPawnId:
      options.localPawnId === undefined ? "p0" : options.localPawnId,
    winnerId: null,
    roundNumber: options.round ?? 1,
    arena: arenaAt(options.radius ?? CONFIG.arena.radius),
    isAiming: false,
    aimDirection: null,
    power: CONFIG.power.default,
  } as GameStateSnapshot;
}

// ── the sentence builders ────────────────────────────────────────────────

describe("elimination sentences", () => {
  it("names a player who went from alive to eliminated", () => {
    const before = snap();
    const after = snap({ eliminated: [2] });
    expect(newlyEliminated(before, after).map((p) => p.id)).toEqual(["p2"]);
    expect(eliminationAnnouncement(before, after, "p0")).toBe(
      "Player 3 was knocked out."
    );
  });

  it("uses the second person for the viewer's own elimination", () => {
    expect(eliminationAnnouncement(snap(), snap({ eliminated: [0] }), "p0")).toBe(
      "You were knocked out."
    );
  });

  it("reports simultaneous eliminations in ONE sentence, roster order", () => {
    // p1, p3 and p4 all leave in the same resolution.
    const sentence = eliminationAnnouncement(
      snap(),
      snap({ eliminated: [4, 1, 3] }),
      "p0"
    );
    expect(sentence).toBe("Player 2, Player 4 and Player 5 were knocked out.");
    // One announcement, not three.
    expect(sentence.match(/knocked out/g)).toHaveLength(1);
    // Roster order regardless of the order they were listed.
    expect(sentence.indexOf("Player 2")).toBeLessThan(sentence.indexOf("Player 4"));
    expect(sentence.indexOf("Player 4")).toBeLessThan(sentence.indexOf("Player 5"));
  });

  it("combines the viewer's own elimination with others in one commit", () => {
    const sentence = eliminationAnnouncement(
      snap(),
      snap({ eliminated: [0, 2] }),
      "p0"
    );
    expect(sentence).toBe("You were knocked out. Player 3 was knocked out.");
  });

  it("says nothing when nobody newly went out", () => {
    expect(eliminationAnnouncement(snap(), snap(), "p0")).toBe("");
    // Already-eliminated players are not re-announced.
    const out = snap({ eliminated: [2] });
    expect(eliminationAnnouncement(out, out, "p0")).toBe("");
    expect(eliminationAnnouncement(out, snap({ eliminated: [2] }), "p0")).toBe("");
  });

  it("says nothing on the very first snapshot", () => {
    // No previous state = no transition, even if pawns are already out.
    expect(eliminationAnnouncement(null, snap({ eliminated: [1] }), "p0")).toBe("");
  });

  it("prefers a custom display name", () => {
    const before = snap();
    const after = snap({ eliminated: [3] });
    after.pawns[3] = { ...after.pawns[3], name: "Ada" };
    expect(eliminationAnnouncement(before, after, "p0")).toBe(
      "Ada was knocked out."
    );
  });

  it("falls back to the seat label when a name is blank", () => {
    const before = snap();
    const after = snap({ eliminated: [3] });
    after.pawns[3] = { ...after.pawns[3], name: "   " };
    expect(eliminationAnnouncement(before, after, "p0")).toBe(
      "Player 4 was knocked out."
    );
  });
});

describe("round transition sentences", () => {
  it("announces the new round when the authoritative ordinal advances", () => {
    expect(roundAnnouncement(snap({ round: 3 }), snap({ round: 4 }))).toBe(
      "Round 4 begins."
    );
  });

  it("says nothing when the round is unchanged", () => {
    expect(roundAnnouncement(snap({ round: 4 }), snap({ round: 4 }))).toBe("");
  });

  it("never announces a round going backwards", () => {
    expect(roundAnnouncement(snap({ round: 5 }), snap({ round: 4 }))).toBe("");
  });

  it("adds the shrink note ONLY when the radius actually decreased", () => {
    // Radius unchanged across the transition → no note.
    expect(
      roundAnnouncement(
        snap({ round: 3, radius: 330 }),
        snap({ round: 4, radius: 330 })
      )
    ).toBe("Round 4 begins.");
    // Radius genuinely smaller → note added.
    expect(
      roundAnnouncement(
        snap({ round: 6, radius: 330 }),
        snap({ round: 7, radius: 290 })
      )
    ).toBe("Round 7 begins. The arena has shrunk.");
  });

  it("does not leak the shrink schedule's internals", () => {
    const sentence = roundAnnouncement(
      snap({ round: 6, radius: 330 }),
      snap({ round: 7, radius: 290 })
    );
    // No radii, no step size, no countdown — just the observable fact.
    expect(sentence).not.toMatch(/330|290|40|radius|units/i);
    expect(sentence).not.toMatch(/next|in \d+ rounds?/i);
  });

  it("stays silent on the first snapshot and at match end", () => {
    expect(roundAnnouncement(null, snap({ round: 1 }))).toBe("");
    // A finished match belongs to the result overlay, not a new round.
    expect(
      roundAnnouncement(
        snap({ round: 4 }),
        snap({ round: 5, phase: "finished" })
      )
    ).toBe("");
  });

  it("stays silent when a snapshot carries no ordinal (older server)", () => {
    const before = snap({ round: 3 });
    const after = snap({ round: 4 });
    delete (after as { roundNumber?: number }).roundNumber;
    expect(roundAnnouncement(before, after)).toBe("");
  });
});

describe("the combined announcement", () => {
  it("reports the eliminations, then the new round", () => {
    expect(
      matchProgressAnnouncement(
        snap({ round: 3 }),
        snap({ round: 4, eliminated: [2] })
      )
    ).toBe("Player 3 was knocked out. Round 4 begins.");
  });

  it("reports a shrink round that also knocked players out", () => {
    expect(
      matchProgressAnnouncement(
        snap({ round: 6, radius: 330 }),
        snap({ round: 7, radius: 290, eliminated: [1, 4] })
      )
    ).toBe(
      "Player 2 and Player 5 were knocked out. Round 7 begins. The arena has shrunk."
    );
  });

  it("is empty for a transition with nothing to say", () => {
    expect(matchProgressAnnouncement(snap({ round: 2 }), snap({ round: 2 }))).toBe("");
  });
});

// ── privacy ──────────────────────────────────────────────────────────────

describe("announcements expose nothing private", () => {
  it("reads only id, name and eliminated from a pawn", () => {
    expect([...ANNOUNCEMENT_PAWN_FIELDS]).toEqual(["id", "name", "eliminated"]);
  });

  it("narrows each pawn to the three public fields, dropping the rest", () => {
    // The structural guarantee: newlyEliminated() COPIES each pawn into
    // a plain object carrying only id/name/eliminated. Whatever private
    // data the snapshot held cannot reach the sentence builders, because
    // it is not on the object they receive.
    const before = snap();
    const after = snap({ round: 4, eliminated: [1, 2] });
    const loaded = {
      ...after,
      pawns: after.pawns.map((p) => ({
        ...p,
        confirmed: true,
        launch: { direction: { x: 0.6, y: -0.8 }, power: 5 },
      })),
    } as GameStateSnapshot;

    for (const out of newlyEliminated(before, loaded)) {
      expect(Object.keys(out).sort()).toEqual([...ANNOUNCEMENT_PAWN_FIELDS].sort());
      const leaked = out as unknown as Record<string, unknown>;
      expect(leaked.launch).toBeUndefined();
      expect(leaked.confirmed).toBeUndefined();
      expect(leaked.velocity).toBeUndefined();
    }
  });

  it("cannot be made to speak a private field, in ANY wording branch", () => {
    // Every branch (one other, several others, the viewer's own, mixed)
    // rendered from pawns whose private fields hold unmistakable
    // sentinel values. None may appear in the output.
    const cases: number[][] = [[2], [1, 2], [0], [0, 3], [1, 2, 4]];
    for (const eliminated of cases) {
      const before = snap();
      const after = snap({ round: 4, eliminated });
      const loaded = {
        ...after,
        power: 4242,
        aimDirection: { x: 0.123456, y: 0.987654 },
        pawns: after.pawns.map((p) => ({
          ...p,
          confirmed: true,
          power: 4242,
          launch: { direction: { x: 0.123456, y: 0.987654 }, power: 4242 },
        })),
      } as unknown as GameStateSnapshot;

      const sentence = matchProgressAnnouncement(before, loaded);
      expect(sentence).not.toContain("4242");
      expect(sentence).not.toContain("0.123456");
      expect(sentence).not.toContain("0.987654");
      expect(sentence).not.toMatch(/power|aim|direction|ready|confirm/i);
    }
  });

  it("produces identical text whatever the others secretly chose", () => {
    const withSecrets = (power: number, confirmed: boolean) => {
      const s = snap({ round: 4, eliminated: [2] });
      return {
        ...s,
        power,
        aimDirection: { x: 1, y: 0 },
        pawns: s.pawns.map((p) => ({
          ...p,
          confirmed,
          launch: { direction: { x: 0.6, y: -0.8 }, power },
        })),
      } as GameStateSnapshot;
    };
    const base = snap({ round: 3 });
    expect(matchProgressAnnouncement(base, withSecrets(1, false))).toBe(
      matchProgressAnnouncement(base, withSecrets(5, true))
    );
  });

  it("never mentions aim, power or readiness", () => {
    const sentence = matchProgressAnnouncement(
      snap({ round: 6, radius: 330 }),
      snap({ round: 7, radius: 290, eliminated: [1, 3] })
    );
    expect(sentence).not.toMatch(/power|aim|direction|angle|ready|confirm/i);
  });
});

// ── the live region ──────────────────────────────────────────────────────

/** Flush the post-mount publication effect. */
async function flush(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
}

const region = () => screen.getByTestId("match-progress-announcement");

describe("the mid-match live region", () => {
  it("is polite, atomic and visually hidden", async () => {
    render(<MatchProgressAnnouncer snapshot={snap()} />);
    await flush();
    expect(region()).toHaveAttribute("role", "status");
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("aria-atomic", "true");
    expect(region()).toHaveClass("sr-only");
    expect(region()).not.toHaveAttribute("aria-hidden");
  });

  it("starts empty and stays silent on the first snapshot", async () => {
    render(<MatchProgressAnnouncer snapshot={snap({ round: 1 })} />);
    expect(region()).toHaveTextContent("");
    await flush();
    // Arriving mid-match must not replay history.
    expect(region()).toHaveTextContent("");
  });

  it("announces an elimination on the authoritative transition", async () => {
    const view = render(<MatchProgressAnnouncer snapshot={snap({ round: 3 })} />);
    await flush();
    view.rerender(
      <MatchProgressAnnouncer snapshot={snap({ round: 3, eliminated: [2] })} />
    );
    await flush();
    expect(region()).toHaveTextContent("Player 3 was knocked out.");
  });

  it("announces a round transition", async () => {
    const view = render(<MatchProgressAnnouncer snapshot={snap({ round: 3 })} />);
    await flush();
    view.rerender(<MatchProgressAnnouncer snapshot={snap({ round: 4 })} />);
    await flush();
    expect(region()).toHaveTextContent("Round 4 begins.");
  });

  it("does NOT repeat on duplicate snapshots", async () => {
    const view = render(<MatchProgressAnnouncer snapshot={snap({ round: 3 })} />);
    await flush();
    view.rerender(<MatchProgressAnnouncer snapshot={snap({ round: 4 })} />);
    await flush();
    const announced = region().textContent;
    expect(announced).toBe("Round 4 begins.");

    // The same round pushed repeatedly (the normal snapshot cadence).
    for (let i = 0; i < 4; i++) {
      view.rerender(<MatchProgressAnnouncer snapshot={snap({ round: 4 })} />);
      await flush();
    }
    expect(region().textContent).toBe(announced);
  });

  it("does not re-announce an elimination already reported", async () => {
    const view = render(<MatchProgressAnnouncer snapshot={snap({ round: 3 })} />);
    await flush();
    view.rerender(
      <MatchProgressAnnouncer snapshot={snap({ round: 3, eliminated: [2] })} />
    );
    await flush();
    expect(region()).toHaveTextContent("Player 3 was knocked out.");

    // Further snapshots still show p2 eliminated — but it is old news.
    for (let i = 0; i < 3; i++) {
      view.rerender(
        <MatchProgressAnnouncer snapshot={snap({ round: 3, eliminated: [2] })} />
      );
      await flush();
    }
    expect(region().textContent).toBe("Player 3 was knocked out.");
  });

  it("announces successive events as they happen", async () => {
    const view = render(<MatchProgressAnnouncer snapshot={snap({ round: 3 })} />);
    await flush();

    view.rerender(
      <MatchProgressAnnouncer snapshot={snap({ round: 4, eliminated: [1] })} />
    );
    await flush();
    expect(region()).toHaveTextContent("Player 2 was knocked out. Round 4 begins.");

    view.rerender(
      <MatchProgressAnnouncer snapshot={snap({ round: 5, eliminated: [1, 3] })} />
    );
    await flush();
    expect(region()).toHaveTextContent("Player 4 was knocked out. Round 5 begins.");
  });

  it("renders nothing visible", async () => {
    const view = render(<MatchProgressAnnouncer snapshot={snap({ round: 2 })} />);
    await flush();
    // Only the sr-only region exists — no visible node was added.
    expect(view.container.querySelectorAll(":not(.sr-only)")).toHaveLength(0);
  });

  it("tolerates a null snapshot (pre-match / disconnected)", async () => {
    expect(() => render(<MatchProgressAnnouncer snapshot={null} />)).not.toThrow();
    await flush();
    expect(region()).toHaveTextContent("");
  });
});
