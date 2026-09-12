// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG, playerColor, type GameStateSnapshot, type PawnSnapshot } from "../../game";
import { MatchRail } from "../components/game/MatchRail";
import { MatchResultOverlay } from "../components/game/MatchResultOverlay";
import { SeatList, MAX_SEATS } from "../components/lobby/SeatList";

/**
 * SIX-PLAYER CLARITY (Task 8) — the DOM half.
 *
 * With six players the rail and the seat list carry the identity load:
 * who am I, who else is in, who is out, who won. These pin that the
 * information is present and correct at full capacity — and that the
 * DOM never carries a remote player's private aim or power.
 */

const MAX = CONFIG.match.maxPlayers;

// No vitest globals in this project → unmount React trees by hand.
afterEach(() => {
  cleanup();
});

function pawn(slot: number, overrides: Partial<PawnSnapshot> = {}): PawnSnapshot {
  return {
    id: `p${slot}`,
    name: `Player ${slot + 1}`,
    position: { x: 100 + slot * 20, y: 100 },
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

function snapshot(overrides: Partial<GameStateSnapshot> = {}): GameStateSnapshot {
  return {
    phase: "aiming",
    pawns: Array.from({ length: MAX }, (_, i) => pawn(i)),
    localPawnId: "p0",
    winnerId: null,
    isAiming: false,
    aimDirection: null,
    power: CONFIG.power.default,
    ...overrides,
  } as GameStateSnapshot;
}

describe("the match rail identifies all six players", () => {
  it("lists six players, each with a name and its own color swatch", () => {
    render(<MatchRail snapshot={snapshot()} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    for (let i = 0; i < MAX; i++) {
      const entry = within(rail).getByTestId(`rail-p${i}`);
      expect(entry).toHaveTextContent(`Player ${i + 1}`);
      // The swatch carries this seat's palette color.
      const swatch = entry.querySelector("span[aria-hidden]") as HTMLElement;
      expect(swatch).toBeTruthy();
      expect(swatch.style.backgroundColor).not.toBe("");
    }
    expect(within(rail).getAllByTestId(/^rail-p/)).toHaveLength(MAX);
  });

  it("marks exactly one You and one Host among six", () => {
    render(<MatchRail snapshot={snapshot()} hostPlayerId="p3" />);
    const rail = screen.getByTestId("match-rail");
    expect(within(rail).getAllByText("You")).toHaveLength(1);
    expect(within(rail).getAllByText("Host")).toHaveLength(1);
    expect(within(rail).getByTestId("rail-p0")).toHaveTextContent("You");
    expect(within(rail).getByTestId("rail-p3")).toHaveTextContent("Host");
  });

  it("shows who is out and who is still in", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { eliminated: i >= 4 })
    );
    render(<MatchRail snapshot={snapshot({ pawns })} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    expect(within(rail).getAllByText("Out")).toHaveLength(2);
    for (const i of [4, 5]) {
      expect(within(rail).getByTestId(`rail-p${i}`)).toHaveTextContent("Out");
    }
    for (const i of [0, 1, 2, 3]) {
      expect(within(rail).getByTestId(`rail-p${i}`)).not.toHaveTextContent("Out");
    }
  });

  it("shows readiness for six without showing anyone's choice", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { confirmed: i % 2 === 0 })
    );
    render(<MatchRail snapshot={snapshot({ pawns })} hostPlayerId="p0" />);
    const rail = screen.getByTestId("match-rail");
    expect(within(rail).getAllByText("Ready")).toHaveLength(3);
    expect(within(rail).getAllByText("Choosing…")).toHaveLength(3);
    // Readiness is all it reveals: no direction, no power, anywhere.
    expect(rail.textContent).not.toMatch(/power/i);
    expect(rail.textContent).not.toMatch(/aim/i);
  });

  it("leaks no remote aim or power into the DOM", () => {
    // A resolved round: launches are public here, but during AIMING the
    // projection nulls them — the rail must render identically whether
    // or not remote players have secretly chosen.
    const quiet = Array.from({ length: MAX }, (_, i) => pawn(i));
    const chosen = Array.from({ length: MAX }, (_, i) =>
      pawn(i, i === 0 ? {} : { confirmed: true })
    );
    const a = render(<MatchRail snapshot={snapshot({ pawns: quiet })} hostPlayerId="p0" />);
    const quietHtml = a.container.innerHTML;
    a.unmount();
    const b = render(<MatchRail snapshot={snapshot({ pawns: chosen })} hostPlayerId="p0" />);
    const chosenHtml = b.container.innerHTML;
    // They differ only by the readiness word — never by a number that
    // could encode power, nor by any direction.
    expect(quietHtml).toContain("Choosing…");
    expect(chosenHtml).toContain("Ready");
    for (const html of [quietHtml, chosenHtml]) {
      expect(html).not.toMatch(/aimDirection|"power"|data-power/);
    }
  });
});

describe("the winner is unmistakable with six players", () => {
  it("names the winner to the five who lost", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { eliminated: i !== 5, name: `Player ${i + 1}` })
    );
    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p0"
        pawns={pawns}
        onLeave={() => {}}
      />
    );
    const result = screen.getByTestId("match-result");
    expect(result).toHaveTextContent("Knocked Out!");
    expect(result).toHaveTextContent("Player 6 wins the match.");
  });

  it("congratulates the survivor", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { eliminated: i !== 5 })
    );
    render(
      <MatchResultOverlay
        winnerId="p5"
        localPawnId="p5"
        pawns={pawns}
        onLeave={() => {}}
      />
    );
    expect(screen.getByTestId("match-result")).toHaveTextContent("Victory!");
  });

  it("keeps the winner highlighted in the rail", () => {
    const pawns = Array.from({ length: MAX }, (_, i) =>
      pawn(i, { eliminated: i !== 5 })
    );
    render(
      <MatchRail
        snapshot={snapshot({ phase: "finished", pawns, winnerId: "p5" })}
        hostPlayerId="p0"
      />
    );
    const rail = screen.getByTestId("match-rail");
    // Five struck through, the champion untouched.
    expect(within(rail).getAllByText("Out")).toHaveLength(5);
    expect(within(rail).getByTestId("rail-p5")).not.toHaveTextContent("Out");
  });
});

describe("the six-seat lobby stays compact and correct", () => {
  const roster = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      playerId: `p${i}`,
      displayName: null,
      connected: true,
    }));

  it("renders exactly six rows at full capacity", () => {
    render(<SeatList roster={roster(MAX)} selfPlayerId="p0" hostPlayerId="p0" />);
    const list = screen.getByTestId("seat-list");
    // One row per seat, no placeholders, no scroll container needed.
    expect(list.children).toHaveLength(MAX);
    expect(screen.queryAllByTestId("empty-seat")).toHaveLength(0);
  });

  it("always shows exactly six rows, seated plus placeholders", () => {
    for (let seated = 1; seated <= MAX; seated++) {
      const view = render(
        <SeatList roster={roster(seated)} selfPlayerId="p0" hostPlayerId="p0" />
      );
      const list = screen.getByTestId("seat-list");
      expect(list.children).toHaveLength(MAX);
      expect(screen.queryAllByTestId("empty-seat")).toHaveLength(MAX - seated);
      view.unmount();
    }
  });

  it("labels empty seats for screen readers", () => {
    render(<SeatList roster={roster(2)} selfPlayerId="p0" hostPlayerId="p0" />);
    const empties = screen.getAllByTestId("empty-seat");
    expect(empties).toHaveLength(MAX - 2);
    for (const seat of empties) {
      expect(within(seat).getByLabelText("empty seat")).toBeInTheDocument();
      expect(seat).toHaveTextContent("Waiting for player…");
    }
  });

  it("reports connection state per seat with six players", () => {
    const mixed = roster(MAX).map((s, i) => ({ ...s, connected: i !== 5 }));
    render(<SeatList roster={mixed} selfPlayerId="p0" hostPlayerId="p0" />);
    expect(within(screen.getByTestId("seat-p5")).getByLabelText("disconnected")).toBeInTheDocument();
    expect(screen.getAllByLabelText("connected")).toHaveLength(MAX - 1);
    expect(screen.getByTestId("seat-p5")).toHaveTextContent("Disconnected");
  });

  it("keeps names, You and Host correct at six seats", () => {
    const named = roster(MAX).map((s, i) => ({
      ...s,
      displayName: i === 2 ? "Ada" : null,
    }));
    render(<SeatList roster={named} selfPlayerId="p4" hostPlayerId="p1" />);
    const list = screen.getByTestId("seat-list");
    expect(within(screen.getByTestId("seat-p2")).getByText("Ada")).toBeInTheDocument();
    expect(within(screen.getByTestId("seat-p0")).getByText("Player 1")).toBeInTheDocument();
    expect(within(list).getAllByText("You")).toHaveLength(1);
    expect(within(list).getAllByText("Host")).toHaveLength(1);
    expect(screen.getByTestId("seat-p4")).toHaveTextContent("You");
    expect(screen.getByTestId("seat-p1")).toHaveTextContent("Host");
  });

  it("uses the derived capacity, not a hard-coded six", () => {
    expect(MAX_SEATS).toBe(CONFIG.match.maxPlayers);
    expect(playerColor(MAX_SEATS - 1)).toBe(playerColor(CONFIG.match.maxPlayers - 1));
  });
});
