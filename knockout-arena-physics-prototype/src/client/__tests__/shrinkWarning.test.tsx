// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, type ArenaSnapshot, type GamePhase, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { ShrinkWarning } from "../components/game/ShrinkWarning";

/**
 * The shrinking-arena WARNING — the presentation half of the
 * authoritative mechanic.
 *
 * Every rule here is the same one: the component renders what the
 * SNAPSHOT says and nothing else. It has no schedule, no round counter
 * and no deadline of its own, so it cannot warn at the wrong moment,
 * cannot keep warning after a shrink, and cannot survive a reconnect
 * with stale data.
 *
 * Deadlines are crafted relative to Date.now() so nothing waits.
 */

afterEach(cleanup);

const warning = () => screen.getByTestId("shrink-warning");
const absent = () => screen.queryByTestId("shrink-warning");
const seconds = () => screen.getByTestId("shrink-warning-seconds");

const INITIAL = CONFIG.arena.radius;
const STEP = CONFIG.arena.shrink.amount;
const EVERY = CONFIG.arena.shrink.everyRounds;
const MIN = CONFIG.arena.shrink.minRadius;

function pawn(id: string): PawnSnapshot {
  return {
    id,
    name: id,
    position: { x: 450, y: 350 },
    velocity: { x: 0, y: 0 },
    radius: 16,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: id === "p0",
    colorIndex: 0,
  };
}

function arena(overrides: Partial<ArenaSnapshot> = {}): ArenaSnapshot {
  return {
    radius: INITIAL,
    roundsUntilShrink: EVERY,
    nextRadius: INITIAL - STEP,
    shrinkWarning: false,
    atMinRadius: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot {
  const phase: GamePhase = overrides.phase ?? "aiming";
  return {
    phase,
    pawns: [pawn("p0"), pawn("p1")],
    localPawnId: "p0",
    winnerId: null,
    power: 3,
    aimDirection: null,
    isAiming: false,
    arena: arena(),
    roundDeadline: Date.now() + 10_000,
    ...overrides,
  };
}

/** The state one round before a shrink: the server has set the flag. */
function warned(overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot {
  return snapshot({
    arena: arena({ roundsUntilShrink: 1, shrinkWarning: true }),
    ...overrides,
  });
}

describe("ShrinkWarning (presentation of the authoritative shrink schedule)", () => {
  it("stays hidden while the server reports no imminent shrink", () => {
    render(<ShrinkWarning snapshot={snapshot()} />);
    expect(absent()).toBeNull();
  });

  it("announces the shrink with a countdown when the server warns", () => {
    render(<ShrinkWarning snapshot={warned()} />);
    expect(warning()).toHaveTextContent("Arena shrinking");
    expect(seconds()).toHaveTextContent("10s"); // a full decision window
  });

  it("shows the authoritative sizes of the coming shrink", () => {
    render(<ShrinkWarning snapshot={warned()} />);
    expect(screen.getByTestId("shrink-warning-radius")).toHaveTextContent(
      `${INITIAL} → ${INITIAL - STEP}`
    );
  });

  it("is announced to assistive tech without stealing focus", () => {
    render(<ShrinkWarning snapshot={warned()} />);
    const badge = warning();
    expect(badge).toHaveAttribute("role", "status");
    expect(badge).toHaveAttribute("aria-live", "polite");
    expect(badge).toHaveAccessibleName("Warning: the arena shrinks in 10 seconds");
  });

  it("counts down from the SERVER's deadline and clamps at zero", async () => {
    render(
      <ShrinkWarning
        snapshot={warned({ roundDeadline: Date.now() + 2_900 })}
      />
    );
    const initial = Number(seconds().textContent!.replace("s", ""));
    expect(initial).toBeLessThanOrEqual(3);
    await waitFor(
      () =>
        expect(
          Number(seconds().textContent!.replace("s", ""))
        ).toBeLessThan(initial),
      { timeout: 1500 }
    );

    cleanup();
    // Past the deadline: it holds 0 while awaiting the server's next
    // snapshot — it never goes negative and never acts on its own.
    render(
      <ShrinkWarning snapshot={warned({ roundDeadline: Date.now() - 5_000 })} />
    );
    expect(seconds()).toHaveTextContent("0s");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(seconds()).toHaveTextContent("0s");
  });

  it("marks the final seconds as urgent (and only those)", () => {
    const calm = render(
      <ShrinkWarning snapshot={warned({ roundDeadline: Date.now() + 9_000 })} />
    );
    expect(warning()).toHaveAttribute("data-urgent", "false");
    calm.unmount();
    render(
      <ShrinkWarning snapshot={warned({ roundDeadline: Date.now() + 1_500 })} />
    );
    expect(warning()).toHaveAttribute("data-urgent", "true");
  });

  it("DISAPPEARS as soon as the post-shrink snapshot arrives", () => {
    const view = render(<ShrinkWarning snapshot={warned()} />);
    expect(absent()).not.toBeNull();
    // The shrink happened: the server cleared the flag and sent the new
    // radius. Nothing client-side has to be reset for the badge to go.
    view.rerender(
      <ShrinkWarning
        snapshot={snapshot({
          arena: arena({
            radius: INITIAL - STEP,
            nextRadius: INITIAL - STEP * 2,
            roundsUntilShrink: EVERY,
            shrinkWarning: false,
          }),
        })}
      />
    );
    expect(absent()).toBeNull();
  });

  it("never warns once the arena has reached its minimum size", () => {
    render(
      <ShrinkWarning
        snapshot={snapshot({
          arena: arena({
            radius: MIN,
            roundsUntilShrink: null,
            nextRadius: null,
            shrinkWarning: false,
            atMinRadius: true,
          }),
        })}
      />
    );
    expect(absent()).toBeNull();
  });

  it("shows nothing while a round resolves or after the match ends", () => {
    for (const phase of ["moving", "finished"] as const) {
      const view = render(
        <ShrinkWarning snapshot={warned({ phase })} />
      );
      expect(absent()).toBeNull();
      view.unmount();
    }
  });

  it("tolerates a snapshot with no arena field (older server)", () => {
    const legacy = snapshot();
    delete (legacy as { arena?: unknown }).arena;
    render(<ShrinkWarning snapshot={legacy} />);
    expect(absent()).toBeNull();
  });

  it("renders the warning even when the deadline is missing", () => {
    // Backward-safe: no countdown material → the warning still appears,
    // just without a number. It never invents a deadline.
    render(<ShrinkWarning snapshot={warned({ roundDeadline: null })} />);
    expect(warning()).toHaveTextContent("Arena shrinking");
    expect(screen.queryByTestId("shrink-warning-seconds")).toBeNull();
  });

  it("derives everything from the LATEST snapshot (late delivery / reconnect)", () => {
    // A client that starts mid-match with a half-elapsed schedule shows
    // the correct state on its very first render — there is no local
    // history to rebuild.
    render(
      <ShrinkWarning
        snapshot={warned({
          arena: arena({
            radius: INITIAL - STEP,
            nextRadius: INITIAL - STEP * 2,
            roundsUntilShrink: 1,
            shrinkWarning: true,
          }),
          roundDeadline: Date.now() + 4_000,
        })}
      />
    );
    expect(screen.getByTestId("shrink-warning-radius")).toHaveTextContent(
      `${INITIAL - STEP} → ${INITIAL - STEP * 2}`
    );
    expect(seconds()).toHaveTextContent("4s");
  });

  it("never blocks aiming or the controls (pointer-events-none overlay)", () => {
    const { container } = render(<ShrinkWarning snapshot={warned()} />);
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className).toContain("pointer-events-none");
    // The badge itself must not re-enable pointer capture anywhere.
    expect(warning().className).not.toContain("pointer-events-auto");
  });
});
