// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrandLogo } from "../components/BrandLogo";
import { Header } from "../components/Header";

/**
 * TASK 32 — the new logo and favicon.
 *
 * The logo is a rounded-square icon frame that stands in for the "K",
 * set against the word "nockout Arena". The artwork is fixed: these
 * tests pin the geometry that must not drift (circle positions and
 * radii, arrow endpoints, the viewBox) as well as the accessibility
 * contract, because a logo that announces itself twice inside a heading
 * is the easy mistake here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(cleanup);

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p));
const readText = (p: string) => read(p).toString("utf8");

describe("the logo artwork", () => {
  it("renders the icon frame and the wordmark", () => {
    render(<BrandLogo height={30} />);
    const svg = screen.getByTestId("brand-logo");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    // The frame stands in for the K, so the text is the REST of the word.
    expect(svg.textContent).toContain("nockout Arena");
    // …and must not re-add the K the frame already represents.
    expect(svg.textContent).not.toContain("Knockout Arena");
  });

  it("keeps the supplied geometry exactly", () => {
    render(<BrandLogo height={30} />);
    const svg = screen.getByTestId("brand-logo");
    expect(svg.getAttribute("viewBox")).toBe("0 0 460 90");

    const rect = svg.querySelector("rect")!;
    expect(rect.getAttribute("width")).toBe("80");
    expect(rect.getAttribute("height")).toBe("80");
    expect(rect.getAttribute("rx")).toBe("16");
    expect(rect.getAttribute("fill")).toBe("#20293a");
    expect(rect.getAttribute("stroke")).toBe("#2f3b52");

    const circles = Array.from(svg.querySelectorAll("circle"));
    expect(circles).toHaveLength(2);
    // Red pawn above, blue pawn below, same x, same radius.
    expect(circles[0].getAttribute("fill")).toBe("#e53935");
    expect(circles[0].getAttribute("cx")).toBe("31");
    expect(circles[0].getAttribute("cy")).toBe("31");
    expect(circles[1].getAttribute("fill")).toBe("#1e88e5");
    expect(circles[1].getAttribute("cx")).toBe("31");
    expect(circles[1].getAttribute("cy")).toBe("55");
    for (const c of circles) {
      expect(c.getAttribute("r")).toBe("13");
      expect(c.getAttribute("stroke")).toBe("#ffffff");
    }

    const lines = Array.from(svg.querySelectorAll("line"));
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute("x2")).toBe("67");
    expect(lines[0].getAttribute("y2")).toBe("67");
    expect(lines[1].getAttribute("x2")).toBe("67");
    expect(lines[1].getAttribute("y2")).toBe("13");
  });

  it("points both arrows with a marker", () => {
    render(<BrandLogo height={30} />);
    const svg = screen.getByTestId("brand-logo");
    const marker = svg.querySelector("marker")!;
    expect(marker).not.toBeNull();
    const id = marker.getAttribute("id")!;
    for (const line of Array.from(svg.querySelectorAll("line"))) {
      expect(line.getAttribute("marker-end")).toBe(`url(#${id})`);
    }
  });

  it("scales by height and keeps the 460:90 aspect ratio", () => {
    const { rerender } = render(<BrandLogo height={30} />);
    let svg = screen.getByTestId("brand-logo");
    expect(Number(svg.getAttribute("height"))).toBe(30);
    expect(Number(svg.getAttribute("width"))).toBeCloseTo((30 * 460) / 90, 6);

    rerender(<BrandLogo height={26} />);
    svg = screen.getByTestId("brand-logo");
    expect(Number(svg.getAttribute("width"))).toBeCloseTo((26 * 460) / 90, 6);
  });

  it("uses the app's font rather than the SVG default serif", () => {
    render(<BrandLogo height={30} />);
    const text = screen.getByTestId("brand-logo").querySelector("text")!;
    // `inherit` picks up the body stack from index.css.
    expect(text.getAttribute("font-family")).toBe("inherit");
    expect(text.getAttribute("font-weight")).toBe("700");
  });
});

describe("the logo's accessibility", () => {
  it("names itself when it stands alone", () => {
    render(<BrandLogo height={30} />);
    const svg = screen.getByTestId("brand-logo");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg).toHaveAccessibleName("Knockout Arena");
  });

  it("goes silent when marked decorative", () => {
    render(<BrandLogo height={30} decorative />);
    const svg = screen.getByTestId("brand-logo");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    // A hidden image must not also carry a competing name.
    expect(svg.getAttribute("aria-label")).toBeNull();
    expect(svg.getAttribute("role")).not.toBe("img");
  });

  it("is announced exactly once inside a heading", () => {
    // The real usage: heading text + decorative logo. Without the
    // decorative flag this heading would announce its name twice.
    render(<Header phase="aiming" winnerName={null} />);
    const heading = screen.getByRole("heading", { name: "Knockout Arena" });
    expect(heading).toBeInTheDocument();
    // One heading, one name — no second "Knockout Arena" image node.
    expect(screen.queryAllByRole("img", { name: "Knockout Arena" })).toHaveLength(
      0
    );
    // …and the logo really is in there.
    expect(heading.querySelector("svg")).not.toBeNull();
  });

  it("replaces the old KA tile in the header", () => {
    render(<Header phase="aiming" winnerName={null} />);
    expect(screen.getByTestId("brand-logo")).toBeInTheDocument();
    expect(screen.queryByText("KA")).toBeNull();
  });
});

describe("the favicon", () => {
  it("ships the source artwork in public/", () => {
    const svg = readText("public/favicon.svg");
    expect(svg).toContain("<svg");
    // Icon-only: the wordmark belongs to the header logo, not the tile.
    // (The aria-label legitimately says "Knockout Arena icon"; what must
    // be absent is a drawn <text> wordmark.)
    expect(svg).not.toContain("<text");
    // The light tile with black outlines, as specified.
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain("#111111");
    expect(svg).toContain("#e53935");
    expect(svg).toContain("#1e88e5");
  });

  it("ships a real multi-size .ico", () => {
    const ico = read("public/favicon.ico");
    // ICONDIR: reserved=0, type=1 (icon), count=n
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(3);

    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      const w = ico.readUInt8(e) === 0 ? 256 : ico.readUInt8(e);
      const bytes = ico.readUInt32LE(e + 8);
      const offset = ico.readUInt32LE(e + 12);
      sizes.push(w);
      // Each entry is a real PNG payload inside the container.
      expect(ico.subarray(offset, offset + 8).toString("binary")).toBe(
        "\x89PNG\r\n\x1a\n"
      );
      expect(bytes).toBeGreaterThan(0);
      expect(offset + bytes).toBeLessThanOrEqual(ico.length);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });

  it("ships the raster sizes browsers ask for", () => {
    // PNG IHDR carries the real dimensions — trust the bytes, not names.
    const dims = (p: string) => {
      const b = read(p);
      expect(b.subarray(0, 8).toString("binary")).toBe("\x89PNG\r\n\x1a\n");
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    expect(dims("public/apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
    expect(dims("public/icon-192.png")).toEqual({ w: 192, h: 192 });
    expect(dims("public/icon-512.png")).toEqual({ w: 512, h: 512 });
  });

  it("is referenced from index.html", () => {
    const html = readText("index.html");
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+image\/svg\+xml/);
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+image\/x-icon/);
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"[^>]+180x180/);
  });

  it("inlines the icons, because the server serves only one file", () => {
    // src/server/httpServer.ts answers GET "/" and 404s everything else,
    // and the client is bundled by vite-plugin-singlefile — so a
    // href="/favicon.ico" would 404 in production. This is the
    // regression that would silently break the tab icon.
    const html = readText("index.html");
    const links = html.match(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*>/g);
    expect(links).not.toBeNull();
    expect(links!.length).toBe(3);
    for (const link of links!) {
      expect(link).toContain("href=\"data:");
    }
  });
});
