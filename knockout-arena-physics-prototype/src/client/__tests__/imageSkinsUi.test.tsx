// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiscSwatch } from "../components/lobby/SkinPicker";
import {
  skinChoices,
  skinName,
  skinSwatchStyle,
} from "../components/lobby/skins";
import { playerColor } from "../../game";
import { renderLobby, createServerHarness } from "./lobbyTestHarness";

/**
 * The IMAGE skins in the wardrobe UI: the choosable one ("Black hole",
 * id 100) is listed after the palette; the SECRET ones (troll/moai/
 * anime, bound to name triggers) are never listed anywhere. Image
 * swatches render the LARGEST CENTERED CIRCLE of the asset — the CSS
 * path (round element + background cover center) and the SVG path
 * (circle clip + "slice") both implement exactly that crop contract.
 */

afterEach(cleanup);

const picker = () => screen.getByTestId("skin-picker");

describe("the wardrobe lists the image skins correctly", () => {
  it("skinChoices: the black hole after the palette, secrets nowhere", () => {
    const choices = skinChoices().map((c) => c.index);
    expect(choices).toEqual([0, 1, 2, 3, 4, 5, 100]);
    expect(choices).not.toContain(101);
    expect(choices).not.toContain(102);
    expect(choices).not.toContain(103);
    expect(skinName(100)).toBe("Black hole");
  });

  it("the picker menu shows Black hole, never the secret skins", () => {
    renderLobby(createServerHarness().addPlayer().client);
    fireEvent.click(picker());
    expect(screen.getByTestId("skin-option-100")).toBeInTheDocument();
    expect(screen.queryByText("Troll")).toBeNull();
    expect(screen.queryByText("Moai")).toBeNull();
    expect(screen.queryByText("Anime girl")).toBeNull();
  });
});

describe("the image swatch crop contract", () => {
  it("CSS swatch: background cover+center over the fallback color", () => {
    // Image skin: layered asset on a round element = the largest
    // centered circle, any input aspect ratio.
    const style = skinSwatchStyle(100);
    expect(style.backgroundImage).toMatch(/^url\(/);
    expect(style.backgroundSize).toBe("cover");
    expect(style.backgroundPosition).toBe("center");
    expect(style.backgroundColor).toBe(playerColor(100)); // wrapped fallback
    // Palette skins stay a flat color.
    const flat = skinSwatchStyle(3);
    expect(flat.backgroundImage).toBeUndefined();
    expect(flat.backgroundColor).toBeTruthy();
  });

  it("SVG swatch: the image sits inside a circle clip with slice crop", () => {
    const { container } = render(<DiscSwatch skin={100} size={24} />);
    const image = container.querySelector("image");
    expect(image).not.toBeNull();
    expect(image!.getAttribute("preserveAspectRatio")).toBe(
      "xMidYMid slice"
    );
    expect(image!.getAttribute("href")).toBeTruthy();
    expect(container.querySelector("clipPath circle")).not.toBeNull();
    // The fallback disc is painted UNDER the image… (the FIRST circle
    // in the document is the clipPath's own, no fill)
    const under = container.querySelectorAll("circle")[1]!;
    expect(under.getAttribute("fill")).toBe(playerColor(100));
    // …and the gloss stays.
    expect(container.querySelector('circle[fill="rgba(255,255,255,0.35)"]')).not.toBeNull();
  });

  it("palette skins render the plain disc (no image machinery)", () => {
    const { container } = render(<DiscSwatch skin={2} size={24} />);
    expect(container.querySelector("image")).toBeNull();
    expect(container.querySelector("clipPath")).toBeNull();
    expect(container.querySelector("circle")!.getAttribute("fill")).toBe(
      playerColor(2)
    );
  });
});
