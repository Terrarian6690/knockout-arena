// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { playerColor, PLAYER_COLORS } from "../../game";
import {
  allSent,
  connectPlayer,
  createServerHarness,
  renderLobby,
} from "./lobbyTestHarness";
import { loadSkinPreference, skinName } from "../components/lobby/skins";

/**
 * THE DISC-SKIN PICKER.
 *
 * A cosmetic choice of the pawn's look, picked in the MAIN MENU, right
 * of the player-name box. The pinned rules:
 *
 *   - the DEFAULT choice is RANDOM (null): until the player joins a
 *     room or a public game, their skin is unknown — the server deals
 *     it at seating, EXCLUDING the colors the already-seated players
 *     wear — so the button shows the random marker, not any one disc;
 *   - the picker BUTTON itself displays the currently chosen skin (or
 *     the random marker);
 *   - the picker sits in the name row, AFTER (right of) the input;
 *   - an EXPLICIT choice persists across remounts (localStorage);
 *     "Random" clears the stored choice again;
 *   - an explicit choice rides the wire (set_skin) on seating, while a
 *     random player sends nothing — the dealt skin arrives on the
 *     roster, and the seat list shows it as a disc swatch.
 */

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** The trigger button — it previews the current choice. */
const picker = () => screen.getByTestId("skin-picker");

describe("the skin picker on the home screen", () => {
  it("defaults to RANDOM: unknown until joining, marker on the button", () => {
    renderLobby(createServerHarness().addPlayer().client);

    expect(picker()).toHaveAccessibleName("Disc skin: Random. Change skin");
    expect(skinName(null)).toBe("Random");
    // No explicit choice is stored.
    expect(loadSkinPreference()).toBeNull();
    expect(window.localStorage.getItem("knockout-arena.skin")).toBeNull();
    // The marker is the multi-color pie, NOT any single palette disc.
    expect(picker().querySelector('svg circle[fill]:not([fill="none"])')).toBeNull();
    expect(picker().querySelectorAll("svg path")).toHaveLength(
      PLAYER_COLORS.length
    );
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

  it("opens a menu with Random plus every palette skin", () => {
    renderLobby(createServerHarness().addPlayer().client);

    fireEvent.click(picker());
    const menu = screen.getByTestId("skin-menu");
    // Random first, then the six palette colors.
    expect(menu.querySelectorAll("[role=menuitemradio]")).toHaveLength(
      PLAYER_COLORS.length + 1
    );
    expect(screen.getByTestId("skin-option-random")).toBeInTheDocument();
    expect(
      screen.getByTestId("skin-option-random")
    ).toHaveAttribute("aria-checked", "true");

    // Pick Violet (index 5): the button preview switches to the disc.
    fireEvent.click(screen.getByTestId("skin-option-5"));
    expect(screen.queryByTestId("skin-menu")).toBeNull(); // closed again
    expect(picker().querySelector("svg circle")).toHaveAttribute(
      "fill",
      playerColor(5)
    );
    expect(picker()).toHaveAccessibleName("Disc skin: Violet. Change skin");
  });

  it("picking Random clears the explicit choice (localStorage)", () => {
    const harness = createServerHarness();
    renderLobby(harness.addPlayer().client);

    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-2")); // Red
    expect(loadSkinPreference()).toBe(2);

    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-random"));
    expect(loadSkinPreference()).toBeNull();
    expect(window.localStorage.getItem("knockout-arena.skin")).toBeNull();
    // …and the button is back to the random marker.
    expect(picker().querySelector('svg circle[fill]:not([fill="none"])')).toBeNull();
  });

  it("persists an explicit choice across remounts (localStorage)", () => {
    const harness = createServerHarness();
    const client = harness.addPlayer().client;

    renderLobby(client);
    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-2")); // Red
    cleanup();

    // A fresh mount adopts the stored choice, not the random default.
    renderLobby(client);
    expect(picker().querySelector("svg circle")).toHaveAttribute(
      "fill",
      playerColor(2)
    );
  });
});

describe("the skin reaches the seat", () => {
  it("an explicit choice rides the wire on seating; the swatch shows it", async () => {
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
      expect(setSkin).toEqual({
        protocolVersion: 1,
        type: "set_skin",
        skin: 3,
      });
    });

    // The seat's list swatch shows the chosen disc color.
    await waitFor(() => {
      const swatch = screen.getByTestId("skin-swatch-p0");
      return swatch.style.backgroundColor === rgbOf(playerColor(3))
        ? swatch
        : null;
    });
    expect(
      screen.getByTestId("skin-swatch-p0").style.backgroundColor
    ).toBe(rgbOf(playerColor(3)));
  });

  it("LEAVE BUG: after leaving, a skin change at home sends nothing (no not-in-room)", async () => {
    // Protocol v1 never acknowledges a leave, so the client must drop
    // the seat state itself — otherwise the home screen still believes
    // it holds a seat and every cosmetic change there pings a seat that
    // no longer exists ("not-in-room").
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    // Explicit skin, then a room: the choice rides set_skin as usual.
    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-3"));
    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    await screen.findByTestId("room-code");
    await waitFor(() => {
      expect(
        allSent(player.pairs[0]).filter((m) => m.type === "set_skin")
      ).toHaveLength(1);
    });

    // Leave → home. Change the skin AGAIN.
    fireEvent.click(screen.getByTestId("leave-room"));
    await waitFor(() => {
      expect(screen.getByTestId("player-name-input")).toBeInTheDocument();
    });
    fireEvent.click(picker());
    fireEvent.click(screen.getByTestId("skin-option-5"));

    // Still exactly ONE set_skin on the wire (the original one) and no
    // error frame: the seat state is gone locally, nothing was sent to
    // a room the player is no longer in.
    expect(
      allSent(player.pairs[0]).filter((m) => m.type === "set_skin")
    ).toHaveLength(1);
    expect(
      allSent(player.pairs[0]).filter((m) => m.type === "error")
    ).toHaveLength(0);
    // The picker itself shows the new choice.
    expect(picker().querySelector("svg circle")).toHaveAttribute(
      "fill",
      playerColor(5)
    );
  });

  it("a random player sends NOTHING — the dealt skin arrives on the roster", async () => {
    const harness = createServerHarness();
    const player = harness.addPlayer();
    renderLobby(player.client);
    await connectPlayer(player);

    fireEvent.click(screen.getByRole("button", { name: "Create Room" }));
    await screen.findByTestId("room-code");

    // No preference → no set_skin frame at all (the server dealt the
    // skin while seating us; the harness draw is deterministic → 0).
    await waitFor(() => {
      expect(player.client.getState().roster).toHaveLength(1);
    });
    expect(
      allSent(player.pairs[0]).filter((m) => m.type === "set_skin")
    ).toEqual([]);
    expect(player.client.getState().roster[0].skin).toBe(0);

    // The seat list swatch shows the dealt color (orange).
    const swatch = await screen.findByTestId("skin-swatch-p0");
    expect(swatch.style.backgroundColor).toBe(rgbOf(playerColor(0)));
  });
});

/** jsdom reports inline colors as rgb(...) — compare in the same shape. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
