// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYER_COLORS, playerColor } from "../../game";
import {
  allSent,
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";
import { DEFAULT_SKIN, skinName } from "../components/lobby/skins";

/**
 * THE DISC-SKIN PICKER.
 *
 * A cosmetic choice of the pawn's look (a palette index), picked in the
 * MAIN MENU, right of the player-name box. The pinned rules:
 *
 *   - the DEFAULT skin is the palette's ORANGE (index 0);
 *   - the picker BUTTON itself displays the currently chosen skin;
 *   - the picker sits in the name row, AFTER (right of) the input;
 *   - the choice persists across remounts (localStorage);
 *   - joining a room applies the choice to the seat: set_skin rides the
 *     wire (default included), and the roster echoes it back;
 *   - every player list shows the skin: the seat list renders each
 *     seat's disc swatch in their skin color.
 */

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** jsdom reports inline colors as rgb(...) — compare in the same shape. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The trigger button — it previews the current skin. */
const picker = () => screen.getByTestId("skin-picker");

describe("the skin picker on the home screen", () => {
  it("defaults to orange and shows it ON the button", () => {
    renderLobby(createServerHarness().addPlayer().client);

    expect(picker()).toHaveAccessibleName(
      `Disc skin: ${skinName(DEFAULT_SKIN)}. Change skin`
    );
    expect(DEFAULT_SKIN).toBe(0); // palette index 0 IS the orange
    // The trigger's swatch is drawn in the default skin's color.
    const swatch = picker().querySelector("svg circle");
    expect(swatch).toHaveAttribute("fill", playerColor(DEFAULT_SKIN));
    expect(playerColor(DEFAULT_SKIN)).toBe("#ff8a3d"); // orange
  });

  it("sits in the name row, to the RIGHT of the name input", () => {
    renderLobby(createServerHarness().addPlayer().client);

    const input = screen.getByTestId("player-name-input");
    // Same flex row (shared parent), input first, picker right after.
    // (The picker wraps its trigger in a positioning div — compare the
    // wrappers' parents.)
    const row = input.parentElement!;
    expect(picker().parentElement!.parentElement).toBe(row);
    expect(
      input.compareDocumentPosition(picker()) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("opens a menu of every palette skin and applies the pick", () => {
    renderLobby(createServerHarness().addPlayer().client);

    fireEvent.click(picker());
    const menu = screen.getByTestId("skin-menu");
    expect(menu.querySelectorAll("[role=menuitemradio]")).toHaveLength(
      PLAYER_COLORS.length
    );

    // Pick Violet (index 5): the button preview switches to it.
    fireEvent.click(screen.getByTestId("skin-option-5"));
    expect(screen.queryByTestId("skin-menu")).toBeNull(); // closed again
    const swatch = picker().querySelector("svg circle");
    expect(swatch).toHaveAttribute("fill", playerColor(5));
  });

  it("persists the choice across remounts (localStorage)", () => {
    const { client } = (() => {
      const harness = createServerHarness();
      return { client: harness.addPlayer().client };
    })();

    renderLobby(client);
    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-2")); // Red
    cleanup();

    // A fresh mount adopts the stored choice, not the default.
    renderLobby(client);
    const swatch = picker().querySelector("svg circle");
    expect(swatch).toHaveAttribute("fill", playerColor(2));
  });
});

describe("the chosen skin reaches the seat", () => {
  it("joining a room puts set_skin on the wire — chosen skin included", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    // Pick a skin FIRST, then enter a room: the choice must ride along.
    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-3")); // Green
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    await screen.findByTestId("room-code");

    await waitFor(() => {
      const setSkin = allSent(player.pairs[0]).find(
        (m) => m.type === "set_skin"
      );
      expect(setSkin).toEqual({ protocolVersion: 1, type: "set_skin", skin: 3 });
    });

    // …and the seat's list swatch shows the chosen disc color.
    const swatch = await waitFor(() => {
      const el = screen.getByTestId("skin-swatch-p0");
      return el.style.backgroundColor === rgbOf(playerColor(3)) ? el : null;
    });
    expect(swatch).not.toBeNull();
  });

  it("a default-skin player sends the default too (explicit orange)", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    await screen.findByTestId("room-code");

    await waitFor(() => {
      const setSkin = allSent(player.pairs[0]).find(
        (m) => m.type === "set_skin"
      );
      expect(setSkin).toEqual({ protocolVersion: 1, type: "set_skin", skin: 0 });
    });
    // And the wire stays additive: a default seat carries no skin key,
    // so the swatch shows the default orange.
    const swatch = await screen.findByTestId("skin-swatch-p0");
    expect(swatch.style.backgroundColor).toBe(rgbOf(playerColor(0)));
  });
});
