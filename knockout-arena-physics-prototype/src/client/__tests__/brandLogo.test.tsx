// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
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
  it("centres the artwork in the tile with an even margin", () => {
    // The follow-up fix: the drawing used to sit off-centre (left margin
    // 18 vs 14.4 elsewhere) and filled only ~64% of the tile. It is now
    // scaled up and re-centred with a <g transform>, so the icon reads
    // at small sizes instead of floating in white space.
    //
    // The geometry itself is untouched — the circles and lines still
    // carry their original coordinates — so this asserts the WRAPPER
    // does the work.
    const svg = readText("public/favicon.svg");
    const g = /<g transform="([^"]+)"/.exec(svg);
    expect(g).not.toBeNull();
    const transform = g![1];
    // Scaled up about the tile centre…
    const scale = /scale\(([\d.]+)\)/.exec(transform);
    expect(scale).not.toBeNull();
    expect(Number(scale![1])).toBeGreaterThan(1.15);
    // …and the original coordinates survive inside the group.
    expect(svg).toContain('cx="34.2" cy="31.5" r="14.4"');
    expect(svg).toContain('cx="34.2" cy="56.7" r="14.4"');
    // The tile itself must stay full-bleed: the white square is NOT
    // inside the scaled group, or the rounded corners would grow too.
    const gStart = svg.indexOf("<g transform");
    expect(svg.indexOf('<rect')).toBeLessThan(gStart);
  });

  it("proves the centring on the rendered pixels, not just the markup", () => {
    // A transform attribute can be present and still be wrong, so this
    // decodes the real 192px PNG and measures the drawing's bounding box
    // against the tile. Everything that is not near-white counts as ink.
    const { width, height, pixels } = decodePng(read("public/icon-192.png"));
    expect(width).toBe(192);
    expect(height).toBe(192);

    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b, a] = [
          pixels[i],
          pixels[i + 1],
          pixels[i + 2],
          pixels[i + 3],
        ];
        if (a < 20) continue; // outside the rounded tile
        if (r > 235 && g > 235 && b > 235) continue; // the white tile
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    expect(maxX).toBeGreaterThan(0); // something was actually drawn

    const left = minX;
    const right = width - 1 - maxX;
    const top = minY;
    const bottom = height - 1 - maxY;

    // CENTRED: opposite margins match within a pixel of rounding.
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2);

    // SMALL, EVEN GAPS: the drawing fills most of the tile but never
    // touches the rounded corners. Before the fix it filled ~64% of the
    // height and sat off-centre (left margin 18 vs 14.4 elsewhere).
    const fillH = (maxY - minY + 1) / height;
    expect(fillH).toBeGreaterThan(0.8);
    expect(fillH).toBeLessThan(0.92);
    for (const m of [left, right, top, bottom]) {
      expect(m).toBeGreaterThan(0.04 * width); // a real gap remains
      expect(m).toBeLessThan(0.13 * width); // but only a small one
    }
  });

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

/**
 * A minimal PNG reader: enough to get RGBA pixels out of the 8-bit
 * truecolour-with-alpha files sharp writes, so a test can measure the
 * artwork instead of trusting the markup. Handles the five PNG filter
 * types; no interlacing (sharp does not emit it here).
 */
function decodePng(buf: Buffer): {
  width: number;
  height: number;
  pixels: Buffer;
} {
  expect(buf.subarray(0, 8).toString("binary")).toBe("\x89PNG\r\n\x1a\n");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      expect(data.readUInt8(12)).toBe(0); // not interlaced
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  expect(bitDepth).toBe(8);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  expect(channels).toBeGreaterThan(0); // RGB or RGBA only

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[o];
    o += 1;
    const line = Buffer.from(raw.subarray(o, o + stride));
    o += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, pixels: out };
}
