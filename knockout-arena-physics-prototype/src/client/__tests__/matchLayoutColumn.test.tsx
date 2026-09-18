/**
 * @vitest-environment jsdom
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { CONFIG, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { MatchRail } from "../components/game/MatchRail";

/**
 * THE MATCH SCREEN LAYOUT.
 *
 * Two requested changes, pinned here:
 *
 *   1. The roster is a vertical COLUMN, not the horizontal strip it used
 *      to be, and each row is a SINGLE LINE reading name → pawn look →
 *      You. The Host chip, the p0/p1 seat ids and the per-round status
 *      word were all removed on request: the rail answers "who is in
 *      this game, which colour are they, and are they still alive",
 *      and nothing else.
 *   2. An eliminated player's WHOLE ROW is struck through in red, so
 *      being out is visible at a glance instead of inferred from a
 *      dimmed swatch. A living row is bordered green.
 *
 * The match clock's move (header → floating just under the top bar, over
 * the arena) is covered in matchLayoutTimer.test.tsx, which renders the
 * whole screen.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(cleanup);

const CX = CONFIG.arena.centerX;
const CY = CONFIG.arena.centerY;

function pawn(
  id: string,
  name: string,
  over: Partial<PawnSnapshot> = {}
): PawnSnapshot {
  return {
    id,
    name,
    position: { x: CX, y: CY },
    velocity: { x: 0, y: 0 },
    radius: CONFIG.pawn.radius,
    eliminated: false,
    confirmed: false,
    launch: null,
    isLocal: false,
    colorIndex: 0,
    ...over,
  };
}

function snap(
  pawns: readonly PawnSnapshot[],
  phase: GameStateSnapshot["phase"] = "aiming"
): GameStateSnapshot {
  return {
    phase,
    pawns,
    localPawnId: "p0",
    winnerId: null,
    round: 1,
    power: 3,
    aim: null,
    arena: {
      centerX: CX,
      centerY: CY,
      radius: CONFIG.arena.radius,
      wallThickness: CONFIG.arena.wallThickness,
    },
  } as unknown as GameStateSnapshot;
}

const roster = () =>
  snap([
    pawn("p0", "Ada", { isLocal: true }),
    pawn("p1", "Bo", { confirmed: true }),
    pawn("p2", "Cyd", { eliminated: true }),
  ]);

describe("the roster is a vertical column", () => {
  it("stacks players in a column, not a horizontal strip", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    expect(rail.className).toContain("flex-col");
    // The old strip was a horizontal scroller; a column must not be one.
    expect(rail.className).not.toContain("overflow-x-auto");
    expect(rail.className).not.toMatch(/(^|\s)flex-row(\s|$)/);
  });

  it("gives the column a fixed width so the arena keeps the rest", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    expect(rail.className).toMatch(/\bw-\d+\b/); // an explicit width
    expect(rail.className).toContain("shrink-0"); // never squeezed away
  });

  it("renders one row per player, in snapshot order", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    const rows = within(rail).getAllByTestId(/^rail-p\d+$/);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.dataset.testid ?? r.getAttribute("data-testid")))
      .toEqual(["rail-p0", "rail-p1", "rail-p2"]);
  });
});

describe("each row reads name → pawn look → You, on one line", () => {
  it("puts the name before the swatch in document order", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p1" />);
    const row = screen.getByTestId("rail-p0");
    const name = within(row).getByText("Ada");
    const swatch = screen.getByTestId("rail-swatch-p0");
    // compareDocumentPosition: FOLLOWING means the swatch comes after.
    expect(name.compareDocumentPosition(swatch)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("puts the You badge after the swatch", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const row = screen.getByTestId("rail-p0");
    const swatch = screen.getByTestId("rail-swatch-p0");
    const you = within(row).getByText("You");
    expect(swatch.compareDocumentPosition(you)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("carries no Host chip and no seat id", () => {
    // Both were dropped: who hosts is a lobby concern, and "p0" is an
    // internal id that meant nothing to players.
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    expect(within(rail).queryByText("Host")).toBeNull();
    expect(rail.textContent).not.toMatch(/\bp[0-9]\b/);
  });

  it("shows the pawn's own colour in its swatch", () => {
    const pawns = [
      pawn("p0", "Ada", { colorIndex: 0 }),
      pawn("p1", "Bo", { colorIndex: 3 }),
    ];
    render(<MatchRail snapshot={snap(pawns)} hostPlayerId="p0" />);
    const a = screen.getByTestId("rail-swatch-p0");
    const b = screen.getByTestId("rail-swatch-p1");
    expect(a.style.backgroundColor).not.toBe("");
    expect(b.style.backgroundColor).not.toBe("");
    expect(a.style.backgroundColor).not.toBe(b.style.backgroundColor);
  });

  it("carries no per-round status word", () => {
    // Removed on request. Aliveness is the border colour and the strike;
    // per-round readiness is not the rail's job any more.
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    for (const word of ["Choosing…", "Ready", "Out", "Moving"]) {
      expect(within(rail).queryByText(word)).toBeNull();
    }
  });

  it("keeps a row to a single line", () => {
    // One line per player: the row must not wrap its children onto a
    // second line, which is what made the old four-part row tall.
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const row = screen.getByTestId("rail-p0");
    expect(row.className).not.toContain("flex-wrap");
    expect(row.className).not.toContain("flex-col");
    expect(row.className).toContain("items-center");
  });

  it("marks exactly one You", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p1" />);
    const rail = screen.getByTestId("match-rail");
    expect(within(rail).getAllByText("You")).toHaveLength(1);
    expect(within(rail).getByTestId("rail-p0")).toHaveTextContent("You");
  });
});

describe("an eliminated player's row is struck through", () => {
  it("strikes the WHOLE row, not just the name", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const out = screen.getByTestId("rail-p2");
    expect(out.className).toContain("line-through");
    expect(out.dataset.eliminated).toBe("true");
  });

  it("leaves living players unstruck", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    for (const id of ["rail-p0", "rail-p1"]) {
      const row = screen.getByTestId(id);
      expect(row.className).not.toContain("line-through");
      expect(row.dataset.eliminated).toBe("false");
    }
  });

  it("keeps the strike, the dimming and the red border together", () => {
    // Three independent signals for the same fact: the line for sighted
    // players, the greyed name for anyone who cannot make out a thin
    // rule, and the border colour that carries across the whole tile.
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const out = screen.getByTestId("rail-p2");
    expect(out.className).toContain("line-through");
    expect(out.className).toContain("border-red-500/70");
    const name = within(out).getByText("Cyd");
    expect(name.className).toContain("text-white/40");
  });

  it("borders a living player green and an eliminated one red", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    expect(screen.getByTestId("rail-p0").className).toContain(
      "border-emerald-500/60"
    );
    expect(screen.getByTestId("rail-p1").className).toContain(
      "border-emerald-500/60"
    );
    const out = screen.getByTestId("rail-p2");
    expect(out.className).toContain("border-red-500/70");
    expect(out.className).not.toContain("border-emerald-500/60");
  });

  it("strikes every eliminated player when several are out", () => {
    const pawns = [
      pawn("p0", "Ada", { isLocal: true }),
      pawn("p1", "Bo", { eliminated: true }),
      pawn("p2", "Cyd", { eliminated: true }),
      pawn("p3", "Di"),
    ];
    render(<MatchRail snapshot={snap(pawns)} hostPlayerId="p0" />);
    expect(screen.getByTestId("rail-p1").className).toContain("line-through");
    expect(screen.getByTestId("rail-p2").className).toContain("line-through");
    expect(screen.getByTestId("rail-p0").className).not.toContain(
      "line-through"
    );
    expect(screen.getByTestId("rail-p3").className).not.toContain(
      "line-through"
    );
  });

  it("still names the eliminated player (struck, not hidden)", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const out = screen.getByTestId("rail-p2");
    expect(out).toHaveTextContent("Cyd");
    // The swatch stays too — greyed, so the colour no longer competes
    // with the living players' pawns.
    expect(screen.getByTestId("rail-swatch-p2")).toBeInTheDocument();
  });
});
