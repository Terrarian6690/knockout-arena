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
    // …and the wins section is the bare NUMBER first, the TROPHY BADGE
    // after it — both three times the regular tile text.
    for (const id of ["p0", "p1", "p2"]) {
      const trophy = screen.getByTestId(`trophy-${id}`);
      expect(trophy).toBeInTheDocument();
      expect(trophy.getAttribute("width")).toBe("39"); // 3x the old 13
      const winsSpan = screen.getByTestId(`wins-${id}`);
      expect(winsSpan.className).toContain("text-[33px]"); // 3x the old 11
      expect(winsSpan.lastElementChild).toBe(trophy); // number comes first
    }
    expect(screen.getByTestId("wins-p1")).toHaveTextContent("3");
    expect(screen.getByTestId("wins-p2")).toHaveTextContent("1");
    expect(screen.getByTestId("wins-p0")).toHaveTextContent("0");

    // The crown leads the winner's row — the LEFTMOST element of it.
    const winnerRow = screen.getByTestId("seat-p1");
    expect(winnerRow.firstElementChild).toBe(screen.getByTestId("crown-p1"));

    // All of the player's info sits in the left ~3/4 of the tile; the
    // wins section starts where it ends.
    const info = screen.getByTestId("info-p1");
    expect(info.className).toContain("w-3/4");
    expect(
      info.compareDocumentPosition(screen.getByTestId("wins-p1")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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
    expect(screen.getByTestId("wins-p0")).toHaveTextContent("0");
    expect(screen.getByTestId("wins-p1")).toHaveTextContent("0");
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
    expect(screen.getByTestId("wins-p1")).toHaveTextContent("0");
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

  it("shows the disc RIGHT AFTER the nick; empty seats stay placeholders", () => {
    render(
      <SeatList roster={[seat("p0")]} selfPlayerId="p0" />
    );

    const info = screen.getByTestId("info-p0");
    const nick = within(info).getByText("Player 1").parentElement!;
    const swatch = screen.getByTestId("skin-swatch-p0");
    // The disc immediately follows the nick element in the row.
    expect(nick.nextElementSibling).toBe(swatch);
    // …and it is no longer a direct child of the tile (not at the edge).
    expect(swatch.parentElement).toBe(info);
    const empties = screen.getAllByTestId("empty-seat");
    expect(empties.length).toBeGreaterThan(0);
    expect(empties[0]).toHaveTextContent("Waiting for player…");
  });
});
