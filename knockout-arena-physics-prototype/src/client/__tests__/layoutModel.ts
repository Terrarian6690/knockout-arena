/**
 * A small vertical-layout model for the lobby screens.
 *
 * jsdom has no layout engine (every getBoundingClientRect() is 0×0), and
 * this sandbox has no headless browser, so "does the waiting screen fit
 * on a laptop?" cannot be answered by measuring the real thing. Instead
 * this walks the REAL rendered DOM and adds up the block-flow height
 * implied by the Tailwind classes actually present on it: padding,
 * borders, margins, gaps and text line-heights.
 *
 * It is a MODEL, not a browser:
 *   - it measures the normal vertical block flow only (the lobby is a
 *     plain column of blocks, which is exactly what it is good at);
 *   - flex ROWS are collapsed to their tallest child, since a row's
 *     height is what the column sees;
 *   - it assumes text fits on one line — true for this UI at ≥360px
 *     wide, where the long strings are the hint paragraphs.
 *
 * Its value is COMPARATIVE and it is used that way: the same model
 * measures before and after, so a reported reduction is real even if the
 * absolute pixel count is a few percent off a real browser's.
 */

/** Tailwind's default spacing scale: 1 unit = 4px. */
const UNIT = 4;

/** text-<size> → [font-size, line-height] in px (Tailwind defaults). */
const TEXT_SIZES: Record<string, [number, number]> = {
  "text-\\[10px\\]": [10, 14],
  "text-\\[11px\\]": [11, 16],
  "text-xs": [12, 16],
  "text-sm": [14, 20],
  "text-base": [16, 24],
  "text-lg": [18, 28],
  "text-xl": [20, 28],
  "text-2xl": [24, 32],
  "text-3xl": [30, 36],
  "text-4xl": [36, 40],
  "text-5xl": [48, 48],
  "text-6xl": [60, 60],
};

/** The line-height an element's own text renders at. */
function lineHeightOf(classes: readonly string[]): number {
  let fontSize = 16;
  let lineHeight = 24; // inherited base: text-base
  for (const cls of classes) {
    for (const [pattern, [fs, lh]] of Object.entries(TEXT_SIZES)) {
      if (new RegExp(`^${pattern}$`).test(cls)) {
        fontSize = fs;
        lineHeight = lh;
      }
    }
  }
  // Explicit line-height utilities override the size's default pairing.
  if (classes.includes("leading-none")) return fontSize;
  if (classes.includes("leading-tight")) return Math.round(fontSize * 1.25);
  if (classes.includes("leading-snug")) return Math.round(fontSize * 1.375);
  if (classes.includes("leading-relaxed")) return Math.round(fontSize * 1.625);
  return lineHeight;
}

/** Numeric value of a spacing class like `mt-4`, `py-1.5`, `gap-2`. */
function spacing(classes: readonly string[], prefixes: readonly string[]): number {
  let total = 0;
  for (const prefix of prefixes) {
    for (const cls of classes) {
      // Ignore responsive variants: the model measures the base (mobile
      // -first) layout, plus `sm:` explicitly where asked for.
      const match = new RegExp(`^${prefix}-(\\d+(?:\\.\\d+)?)$`).exec(cls);
      if (match) total += Number.parseFloat(match[1]!) * UNIT;
      const px = new RegExp(`^${prefix}-\\[(\\d+)px\\]$`).exec(cls);
      if (px) total += Number.parseInt(px[1]!, 10);
    }
  }
  return total;
}

/**
 * Classes active at a given breakpoint. `wide` means a desktop viewport,
 * where the `sm:` and `lg:` variants both apply; they are appended in
 * that order so the later one wins, as in the real cascade.
 */
function classesAt(element: Element, wide: boolean): string[] {
  const raw = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  const base: string[] = [];
  for (const cls of raw) {
    if (!cls.includes(":")) base.push(cls);
  }
  if (!wide) return base;
  for (const prefix of ["sm:", "lg:"]) {
    for (const cls of raw) {
      if (cls.startsWith(prefix)) base.push(cls.slice(prefix.length));
    }
  }
  return base;
}

function isHidden(element: Element): boolean {
  const cls = (element.getAttribute("class") ?? "").split(/\s+/);
  return (
    cls.includes("hidden") ||
    cls.includes("sr-only") ||
    cls.includes("absolute") || // taken out of flow
    cls.includes("fixed") ||
    element.getAttribute("aria-hidden") === "true"
  );
}

/**
 * The height this element contributes to its parent's block flow,
 * excluding its own margins (the caller adds those).
 */
function intrinsicHeight(element: Element, wide: boolean): number {
  const cls = classesAt(element, wide);

  const padding = spacing(cls, ["p", "py"]) * (cls.some((c) => /^p-/.test(c)) ? 1 : 1);
  const paddingY =
    spacing(cls, ["py"]) * 2 +
    spacing(cls, ["p"]) * 2 +
    spacing(cls, ["pt"]) +
    spacing(cls, ["pb"]);
  void padding;

  const borderY = cls.some((c) => c === "border" || /^border-[xy]?$/.test(c))
    ? 2
    : 0;

  const children = Array.from(element.children).filter((c) => !isHidden(c));

  // A leaf (or an element whose children are all inline) is one line of
  // text — unless it is genuinely empty, which contributes nothing.
  if (children.length === 0) {
    const text = (element.textContent ?? "").trim();
    const isVoid = element.tagName === "INPUT" || element.tagName === "IMG";
    if (text.length === 0 && !isVoid) return paddingY + borderY;
    return paddingY + borderY + lineHeightOf(cls);
  }

  // A grid lays children out in rows of N columns: its height is the
  // tallest child in each row, summed, plus the row gaps.
  const columns = gridColumns(cls);
  if (columns > 1) {
    const gap = spacing(cls, ["gap", "gap-y"]);
    let gridHeight = 0;
    for (let row = 0; row * columns < children.length; row += 1) {
      const inRow = children.slice(row * columns, (row + 1) * columns);
      let tallest = 0;
      for (const child of inRow) {
        tallest = Math.max(tallest, intrinsicHeight(child, wide) + marginY(child, wide));
      }
      gridHeight += tallest + (row > 0 ? gap : 0);
    }
    return paddingY + borderY + gridHeight;
  }

  const isFlex = cls.includes("flex");
  // `flex-row` wins over `flex-col`: the only way both appear is a
  // responsive override like `flex-col sm:flex-row`, and classesAt()
  // only kept the `sm:` one because we are measuring the wide layout.
  const isRow = isFlex && (cls.includes("flex-row") || !cls.includes("flex-col"));
  const gap = spacing(cls, ["gap", "gap-y"]);

  let content = 0;
  if (isRow) {
    // A row is as tall as its tallest child; its own text (if any) sits
    // on that line too.
    for (const child of children) {
      content = Math.max(content, intrinsicHeight(child, wide) + marginY(child, wide));
    }
    content = Math.max(content, lineHeightOf(cls));
  } else {
    children.forEach((child, index) => {
      content += intrinsicHeight(child, wide) + marginY(child, wide);
      if (index > 0) content += gap;
    });
  }

  return paddingY + borderY + content;
}

/** Column count from `grid-cols-N` (1 when not a grid). */
function gridColumns(classes: readonly string[]): number {
  if (!classes.includes("grid")) return 1;
  // The LAST match wins, mirroring the CSS cascade: `grid-cols-1
  // sm:grid-cols-2` is two columns once the `sm:` variant applies.
  let columns = 1;
  for (const cls of classes) {
    const match = /^grid-cols-(\d+)$/.exec(cls);
    if (match) columns = Number.parseInt(match[1]!, 10);
  }
  return columns;
}

function marginY(element: Element, wide: boolean): number {
  const cls = classesAt(element, wide);
  return (
    spacing(cls, ["mt"]) +
    spacing(cls, ["mb"]) +
    spacing(cls, ["my"]) * 2 +
    spacing(cls, ["m"]) * 2
  );
}

/** Total flow height of `element`, including its own vertical margins. */
export function measureHeight(element: Element, wide = true): number {
  return intrinsicHeight(element, wide) + marginY(element, wide);
}

/** A per-child breakdown, for reporting what actually costs the pixels. */
export function breakdown(
  element: Element,
  wide = true
): Array<{ label: string; height: number }> {
  return Array.from(element.children)
    .filter((child) => !isHidden(child))
    .map((child) => ({
      label:
        child.getAttribute("data-testid") ??
        `${child.tagName.toLowerCase()}.${(child.getAttribute("class") ?? "")
          .split(/\s+/)
          .slice(0, 2)
          .join(".")}`,
      height: measureHeight(child, wide),
    }));
}

/**
 * Common desktop/laptop viewports, with the vertical space a real
 * browser actually leaves a page (OS chrome + tab strip + URL bar).
 */
export const VIEWPORTS: ReadonlyArray<{
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Usable page height after browser chrome. */
  readonly usable: number;
}> = [
  { name: "1366×768 laptop", width: 1366, height: 768, usable: 640 },
  { name: "1440×900 laptop", width: 1440, height: 900, usable: 772 },
  { name: "1536×864 laptop", width: 1536, height: 864, usable: 736 },
  { name: "1920×1080 desktop", width: 1920, height: 1080, usable: 952 },
  { name: "1280×720 small", width: 1280, height: 720, usable: 592 },
];

/** The tightest viewport the lobby must fit in. */
export const TIGHTEST = VIEWPORTS.reduce((a, b) => (a.usable <= b.usable ? a : b));
