// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RosterEntry } from "../network/types";
import { SeatList } from "../components/lobby/SeatList";

/**
 * THE LOBBY'S SEAT LIST, in its match-rail look.
 *
 * The tiles mirror the in-round rail: a green frame while connected, a
 * red one (and muted text) once not. Each row ends with the seat's WIN
 * COUNT, the list is SORTED by it (most wins on top, ties in seat
 * order), and everyone tied at the top wears the crown. A room with no
 * wins yet keeps plain seat order and crowns nobody.
 */

afterEach(cleanup);

function seat(
  playerId: string,
  extra: Partial<RosterEntry> = {}
): RosterEntry {
  return { playerId, connected: true, displayName: null, ...extra };
}

/** The rendered seat ids, in DISPLAY order. */
function order(): string[] {
  return screen
    .getAllByTestId(/^seat-p\d+$/)
    .map((el) => el.getAttribute("data-testid")!.replace("seat-", ""));
}

describe("the seat list ordering and crowns", () => {
  it("sorts by wins (top winner first) and crowns the leader", () => {
    render(
      <SeatList
        roster={[
          seat("p0"),
          seat("p1", { wins: 3, displayName: "Ada" }),
          seat("p2", { wins: 1 }),
        ]}
        selfPlayerId="p0"
      />
    );

    expect(order()).toEqual(["p1", "p2", "p0"]);
    // The crown sits on the top player only.
    expect(screen.getByTestId("crown-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("crown-p0")).toBeNull();
    expect(screen.queryByTestId("crown-p2")).toBeNull();
    // …and the counters are labelled exactly "wins: N".
    expect(screen.getByTestId("wins-p1")).toHaveTextContent("wins: 3");
    expect(screen.getByTestId("wins-p2")).toHaveTextContent("wins: 1");
    expect(screen.getByTestId("wins-p0")).toHaveTextContent("wins: 0");
  });

  it("keeps seat order for ties and crowns every co-leader", () => {
    render(
      <SeatList
        roster={[
          seat("p0", { wins: 2 }),
          seat("p1", { wins: 2 }),
          seat("p2", { wins: 0 }),
        ]}
        selfPlayerId="p2"
      />
    );

    // Equal wins → the original seat order stands.
    expect(order()).toEqual(["p0", "p1", "p2"]);
    expect(screen.getByTestId("crown-p0")).toBeInTheDocument();
    expect(screen.getByTestId("crown-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("crown-p2")).toBeNull();
  });

  it("a winless room keeps seat order and crowns nobody", () => {
    render(
      <SeatList
        roster={[seat("p0"), seat("p1")]}
        selfPlayerId="p0"
      />
    );

    expect(order()).toEqual(["p0", "p1"]);
    expect(screen.queryByTestId(/^crown-/)).toBeNull();
    expect(screen.getByTestId("wins-p0")).toHaveTextContent("wins: 0");
    expect(screen.getByTestId("wins-p1")).toHaveTextContent("wins: 0");
  });

  it("counts an absent wins field as zero (older payload)", () => {
    render(
      <SeatList
        roster={[
          seat("p0", { wins: 1 }),
          // p1 arrives from an older server shape: no wins field at all.
          { playerId: "p1", connected: true, displayName: null },
        ]}
        selfPlayerId="p0"
      />
    );

    expect(order()).toEqual(["p0", "p1"]);
    expect(screen.getByTestId("wins-p1")).toHaveTextContent("wins: 0");
    expect(screen.getByTestId("crown-p0")).toBeInTheDocument();
  });
});

describe("the seat list's match-rail look", () => {
  it("green-framed tiles for the connected, red for the disconnected", () => {
    render(
      <SeatList
        roster={[seat("p0"), seat("p1", { connected: false })]}
        selfPlayerId="p0"
      />
    );

    const alive = screen.getByTestId("seat-p0");
    expect(alive.className).toContain("border-emerald-500/60");
    expect(within(alive).getByText("Connected")).toBeInTheDocument();

    const gone = screen.getByTestId("seat-p1");
    expect(gone.className).toContain("border-red-500/70");
    expect(within(gone).getByText("Disconnected")).toBeInTheDocument();
  });

  it("renders ONE column of rows (no side-by-side grid)", () => {
    render(
      <SeatList
        roster={[seat("p0"), seat("p1")]}
        selfPlayerId="p0"
      />
    );

    const list = screen.getByTestId("seat-list");
    expect(list.className).toContain("flex-col");
    expect(list.className).not.toContain("grid-cols-2");
    expect(list.className).not.toContain("grid-cols-3");
  });

  it("keeps the skin swatch and the empty-seat placeholders", () => {
    render(
      <SeatList roster={[seat("p0")]} selfPlayerId="p0" />
    );

    expect(screen.getByTestId("skin-swatch-p0")).toBeInTheDocument();
    const empties = screen.getAllByTestId("empty-seat");
    expect(empties.length).toBeGreaterThan(0);
    expect(empties[0]).toHaveTextContent("Waiting for player…");
  });
});
