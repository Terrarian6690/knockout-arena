// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectPlayer,
  createServerHarness,
  enterPlayerName,
  renderLobby,
} from "./lobbyTestHarness";
import { breakdown, measureHeight, VIEWPORTS } from "./layoutModel";

/**
 * WAITING-SCREEN REDESIGN (Task 20).
 *
 * Pins the presentation decisions so a later refactor cannot quietly
 * undo them:
 *   - HOST sits in the panel's top-RIGHT corner;
 *   - the "Waiting for players" line sits ABOVE the panel, not in it;
 *   - its ellipsis is animated, and the animation is switched off under
 *     prefers-reduced-motion;
 *   - the room code is visually larger (private rooms only — public
 *     rooms still show no code at all, per Task 18);
 *   - the Invite button is visually distinct from Copy Code;
 *   - the whole screen fits common desktop viewports without scrolling.
 *
 * Everything runs against the REAL server through the in-memory socket
 * harness, so the screens under test are the ones players get.
 */

afterEach(() => {
  cleanup();
});

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(here, "..", "index.css"), "utf8");

/** Seat a rendered player in a public (Quick Play) or private room. */
async function seatedPlayer(kind: "public" | "private") {
  const harness = createServerHarness();
  const player = harness.addPlayer();
  await connectPlayer(player);
  renderLobby(player.client);
  await act(async () => {
    if (kind === "public") fireEvent.click(screen.getByTestId("join-public"));
    else fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
  });
  await screen.findByTestId("room-panel");
  return { harness, player };
}

describe("the HOST indicator sits in the panel's top-right corner", () => {
  it("renders for the host, inside the panel's first row", async () => {
    await seatedPlayer("private");

    const badge = screen.getByTestId("host-badge");
    expect(badge).toHaveTextContent("Host");

    // Structurally top-right: it is in the panel's FIRST child row…
    const panel = screen.getByTestId("room-panel");
    const firstRow = panel.firstElementChild!;
    expect(firstRow).toContainElement(badge);
    // …as that row's LAST element, in a justify-between row (so it is
    // pushed to the right edge rather than merely being present).
    expect(firstRow.className).toContain("justify-between");
    expect(firstRow.lastElementChild).toBe(badge);
  });

  it("is absent for a non-host player", async () => {
    const { harness, player } = await seatedPlayer("private");
    const roomId = player.client.getState().roomId as string;

    const guest = harness.addPlayer();
    await connectPlayer(guest);
    cleanup();
    renderLobby(guest.client);
    await act(async () => {
      guest.client.joinRoom(roomId);
    });
    await screen.findByTestId("room-panel");

    expect(screen.queryByTestId("host-badge")).toBeNull();
  });

  it("does not duplicate the Host marker beside the seat label", async () => {
    await seatedPlayer("private");
    // The corner badge and the one on the player's own seat row — the
    // "You are Player 1" line no longer repeats it a third time.
    const panel = screen.getByTestId("room-panel");
    expect(within(panel).getAllByText("Host")).toHaveLength(2);
    expect(
      within(screen.getByTestId("local-player-id").parentElement!).queryByText("Host")
    ).toBeNull();
  });
});

describe("the waiting text sits above the main panel", () => {
  it("is rendered outside the panel, before it in the document", async () => {
    await seatedPlayer("private");

    const banner = screen.getByTestId("room-state-badge");
    const panel = screen.getByTestId("room-panel");

    expect(banner).toHaveTextContent("Waiting for players");
    // Outside the panel…
    expect(panel).not.toContainElement(banner);
    // …and ABOVE it: same parent, earlier in document order.
    expect(banner.parentElement).toBe(panel.parentElement);
    expect(
      banner.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("announces itself as a status region", async () => {
    await seatedPlayer("private");
    expect(screen.getByTestId("room-state-badge")).toHaveAttribute(
      "role",
      "status"
    );
  });

  it("reads as one phrase for assistive tech", async () => {
    await seatedPlayer("public");
    // The visible dots are decorative; the text carries its own ellipsis.
    const banner = screen.getByTestId("room-state-badge");
    expect(within(banner).getByTestId("animated-ellipsis")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(screen.getByTestId("room-state-badge")).toHaveTextContent(
      /Waiting for players…/
    );
  });
});

describe("the ellipsis animation", () => {
  it("renders three separately animated dots", async () => {
    await seatedPlayer("private");
    const ellipsis = within(
      screen.getByTestId("room-state-badge")
    ).getByTestId("animated-ellipsis");
    const dots = Array.from(ellipsis.children);
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(dot).toHaveClass("ka-ellipsis-dot");
      expect(dot).toHaveTextContent(".");
    }
  });

  it("cycles the dots in sequence via staggered delays", () => {
    // Each dot runs the same keyframes, offset so the wave reads
    // left-to-right rather than all three blinking together.
    expect(CSS).toMatch(/@keyframes ka-ellipsis-dot/);
    expect(CSS).toMatch(/\.ka-ellipsis-dot\s*\{[^}]*animation:\s*ka-ellipsis-dot/);

    const delays = [1, 2, 3].map((n) => {
      const rule = new RegExp(
        `\\.ka-ellipsis-dot:nth-child\\(${n}\\)\\s*\\{[^}]*animation-delay:\\s*(\\d+)ms`
      ).exec(CSS);
      return rule === null ? null : Number.parseInt(rule[1]!, 10);
    });
    expect(delays).toEqual([0, 200, 400]); // strictly increasing stagger

    // The dots fade in and out (opacity cycles), they do not just blink.
    const keyframes = /@keyframes ka-ellipsis-dot\s*\{([\s\S]*?)\n\}/.exec(CSS)![1]!;
    expect(keyframes).toMatch(/opacity:\s*0?\.\d+/); // faded
    expect(keyframes).toMatch(/opacity:\s*1/); // full
  });

  it("is suppressed under prefers-reduced-motion, keeping the dots visible", () => {
    // The reduced-motion block must stop the animation AND leave the
    // dots fully opaque, so the text still reads as an ellipsis.
    const blocks = CSS.split("@media (prefers-reduced-motion: reduce)").slice(1);
    const governing = blocks.find((block) => {
      // The rule must be inside the media block's own braces, i.e. before
      // the block closes — not merely somewhere later in the file.
      const body = block.slice(0, block.indexOf("\n}\n"));
      return body.includes(".ka-ellipsis-dot");
    });
    expect(governing).toBeDefined();
    const rule = /\.ka-ellipsis-dot\s*\{([^}]*)\}/.exec(governing!)![1]!;
    expect(rule).toMatch(/animation:\s*none/);
    expect(rule).toMatch(/opacity:\s*1/);
  });
});

describe("the room code is bigger — private rooms only", () => {
  it("renders at an increased font size", async () => {
    await seatedPlayer("private");
    const code = screen.getByTestId("room-code");
    // text-5xl (48px) — up from text-3xl (30px) before the redesign.
    expect(code).toHaveClass("text-5xl");
    expect(code.className).not.toContain("text-3xl");
    // Still monospace and still the real 4-character code.
    expect(code.className).toContain("font-mono");
    expect(code.textContent).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });

  it("is still labelled for assistive tech", async () => {
    const { player } = await seatedPlayer("private");
    const code = player.client.getState().roomId as string;
    expect(screen.getByTestId("room-code")).toHaveAttribute(
      "aria-label",
      `Room code ${code}`
    );
  });

  it("public rooms still show no code at all (Task 18)", async () => {
    await seatedPlayer("public");
    expect(screen.queryByTestId("room-code")).toBeNull();
    expect(screen.queryByTestId("copy-code")).toBeNull();
    expect(screen.queryByTestId("invite-button")).toBeNull();
    expect(screen.getByTestId("public-room-label")).toHaveTextContent(
      "Quick Play"
    );
  });
});

describe("the Invite button is visually prominent", () => {
  it("is a filled button, unlike the outlined Copy Code beside it", async () => {
    await seatedPlayer("private");
    const invite = screen.getByTestId("invite-button");
    const copy = screen.getByTestId("copy-code");

    // Filled with the design system's emerald "positive action" gradient…
    expect(invite.className).toContain("bg-gradient-to-br");
    expect(invite.className).toContain("from-emerald-400");
    expect(invite.className).toContain("shadow");
    // …against the plain outlined secondary button.
    expect(copy.className).toContain("border-white/15");
    expect(copy.className).not.toContain("bg-gradient-to-br");
    // Distinct from the other primary actions (sky = Quick Play,
    // amber = Create/Start), so it cannot be confused with them.
    expect(invite.className).not.toContain("from-sky-400");
    expect(invite.className).not.toContain("from-amber-400");
  });

  it("still does its job (the Task 14/16 behaviour is untouched)", async () => {
    await seatedPlayer("private");
    expect(screen.getByTestId("invite-button")).toBeEnabled();
    expect(screen.getByTestId("invite-button")).toHaveTextContent("Invite");
  });
});

describe("the lobby fits on screen without scrolling", () => {
  /** Total modelled page height: header + the room column. */
  function pageHeight(): number {
    const header = document.querySelector("header")!;
    const main = document.querySelector("main")!;
    const column = main.firstElementChild!;
    // main's own vertical padding (py-2 in a room, py-3 on the home
    // screen) plus its content.
    const inRoom = document.querySelector('[data-testid="room-panel"]') !== null;
    return measureHeight(header) + measureHeight(column) + (inRoom ? 16 : 24);
  }

  it("the private waiting screen fits every common desktop viewport", async () => {
    await seatedPlayer("private");
    const height = pageHeight();
    const offenders = VIEWPORTS.filter((v) => height > v.usable);
    expect({ height, offenders: offenders.map((v) => v.name) }).toEqual({
      height,
      offenders: [],
    });
  });

  it("the public waiting screen fits every common desktop viewport", async () => {
    await seatedPlayer("public");
    const height = pageHeight();
    const offenders = VIEWPORTS.filter((v) => height > v.usable);
    expect(offenders.map((v) => v.name)).toEqual([]);
  });

  it("the home screen fits every common desktop viewport", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);
    const height = pageHeight();
    const offenders = VIEWPORTS.filter((v) => height > v.usable);
    expect(offenders.map((v) => v.name)).toEqual([]);
  });

  it("a full six-player room still fits", async () => {
    const { harness, player } = await seatedPlayer("private");
    const roomId = player.client.getState().roomId as string;
    for (let i = 1; i < 6; i += 1) {
      const guest = harness.addPlayer();
      await connectPlayer(guest);
      await act(async () => {
        guest.client.joinRoom(roomId);
      });
    }
    await waitFor(() => expect(screen.getByTestId("seat-p5")).toBeInTheDocument());

    const height = pageHeight();
    const offenders = VIEWPORTS.filter((v) => height > v.usable);
    expect(offenders.map((v) => v.name)).toEqual([]);
  });

  it("keeps every functional element that had to survive the resize", async () => {
    await seatedPlayer("private");
    // Nothing was cut to make it fit: seats, counts, code, actions,
    // connection status and the way out are all still here.
    expect(screen.getByTestId("seat-list").children).toHaveLength(6);
    expect(screen.getByTestId("player-count")).toBeInTheDocument();
    expect(screen.getByTestId("room-code")).toBeInTheDocument();
    expect(screen.getByTestId("copy-code")).toBeInTheDocument();
    expect(screen.getByTestId("invite-button")).toBeInTheDocument();
    expect(screen.getByTestId("start-match")).toBeInTheDocument();
    expect(screen.getByTestId("leave-room")).toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toBeInTheDocument();
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    expect(screen.getByTestId("local-player-id")).toBeInTheDocument();
  });

  it("is measurably shorter than the pre-redesign layout", async () => {
    // The pre-redesign private room measured 950px by this same model
    // (header 68 + panel 850 + padding) and overflowed four of the five
    // common viewports. Guard the improvement, not a magic number.
    await seatedPlayer("private");
    expect(pageHeight()).toBeLessThan(800);
  });

  it("reports where the remaining height goes", async () => {
    await seatedPlayer("private");
    const panel = screen.getByTestId("room-panel");
    const parts = breakdown(panel).filter((part) => part.height > 0);
    // A sanity check on the model itself: the parts add up to the whole.
    const sum = parts.reduce((total, part) => total + part.height, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(measureHeight(panel));
  });
});

describe("the waiting hints keep their Task 18 behaviour", () => {
  it("the public lone-player hint still explains the wait", async () => {
    await seatedPlayer("public");
    expect(screen.getByTestId("waiting-for-players")).toHaveTextContent(
      /waiting for another player to join/i
    );
    expect(screen.getByTestId("public-waiting-hint")).toHaveTextContent(
      /matched with the next player who picks Quick Play/i
    );
    expect(screen.getByTestId("leave-room")).toBeInTheDocument();
  });

  it("the private room shows no waiting hint (Task 29)", async () => {
    // Removed deliberately: in a private room the host's own disabled
    // Start button and the seat count already convey the wait. The
    // PUBLIC equivalent is asserted above and is unchanged.
    await seatedPlayer("private");
    expect(screen.queryByTestId("waiting-for-players")).toBeNull();
    expect(screen.queryByTestId("public-waiting-hint")).toBeNull();
  });

  it("those hints animate their ellipsis too", async () => {
    await seatedPlayer("public");
    const hint = screen.getByTestId("waiting-for-players");
    expect(within(hint).getByTestId("animated-ellipsis")).toBeInTheDocument();
    expect(hint).toHaveTextContent(/…/); // still reads as an ellipsis
  });
});

describe("the name gate does not disturb the Quick Play / Create layout", () => {
  it("Quick Play is still the primary action above Create Room", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client);

    const quick = screen.getByTestId("join-public");
    const create = screen.getByRole("button", { name: "Create Room" });
    // Quick Play comes first in the document…
    expect(
      quick.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // …and both are still full-width primary buttons.
    expect(quick.className).toContain("w-full");
    expect(create.className).toContain("w-full");
    // The name box sits above them both.
    const name = screen.getByTestId("player-name-input");
    expect(
      name.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("the name box does not appear once seated (it becomes a rename box)", async () => {
    await seatedPlayer("public");
    expect(screen.queryByTestId("player-name-input")).toBeNull();
    expect(screen.getByTestId("display-name-input")).toHaveValue("Tester");
  });

  it("renders the name box for an un-named player", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    await connectPlayer(player);
    renderLobby(player.client, { playerName: null });
    expect(screen.getByTestId("player-name-input")).toHaveValue("");
    enterPlayerName("Ada");
    expect(screen.getByTestId("player-name-input")).toHaveValue("Ada");
  });
});
