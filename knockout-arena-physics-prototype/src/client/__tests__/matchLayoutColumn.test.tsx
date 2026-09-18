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
 *      to be, and each row reads name → pawn look → Host/You → status.
 *   2. An eliminated player's WHOLE ROW is struck through, so being out
 *      is visible at a glance instead of inferred from a dimmed swatch.
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

describe("each row reads name → pawn look → badge → status", () => {
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

  it("puts the You/Host badge after the swatch", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const row = screen.getByTestId("rail-p0");
    const swatch = screen.getByTestId("rail-swatch-p0");
    const you = within(row).getByText("You");
    const host = within(row).getByText("Host");
    expect(swatch.compareDocumentPosition(you)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(swatch.compareDocumentPosition(host)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
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

  it("keeps the status word in the row", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    expect(screen.getByTestId("rail-p0")).toHaveTextContent("Choosing…");
    expect(screen.getByTestId("rail-p1")).toHaveTextContent("Ready");
    expect(screen.getByTestId("rail-p2")).toHaveTextContent("Out");
  });

  it("marks exactly one You and one Host", () => {
    render(<MatchRail snapshot={roster()} hostPlayerId="p1" />);
    const rail = screen.getByTestId("match-rail");
    expect(within(rail).getAllByText("You")).toHaveLength(1);
    expect(within(rail).getAllByText("Host")).toHaveLength(1);
    expect(within(rail).getByTestId("rail-p0")).toHaveTextContent("You");
    expect(within(rail).getByTestId("rail-p1")).toHaveTextContent("Host");
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

  it("keeps the strike and the dimming together", () => {
    // Two independent signals for the same fact: the line for sighted
    // players, the dimming for anyone who cannot make out a thin rule.
    render(<MatchRail snapshot={roster()} hostPlayerId="p0" />);
    const out = screen.getByTestId("rail-p2");
    expect(out.className).toContain("line-through");
    expect(out.className).toContain("opacity-45");
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
    expect(out).toHaveTextContent("Out");
  });
});
