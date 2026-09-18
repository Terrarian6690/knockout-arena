/**
 * THE KNOCKOUT ARENA LOGO.
 *
 * A rounded-square icon frame standing in for the letter "K", set tight
 * against the word "nockout Arena". One component, used by all three
 * headers (lobby, match, solo) so the brand can never drift between
 * screens the way the old hand-rolled "KA" tile did.
 *
 * GEOMETRY IS FIXED. The circles, arrow angles, stroke widths and the
 * 0 0 460 90 viewBox are the supplied artwork and must not be adjusted —
 * only the rendered height (and therefore the width, via the viewBox's
 * own aspect ratio) changes per screen.
 *
 * COLOURS. The frame is #20293a on a #2f3b52 border, kept exactly as
 * supplied: measured against the real header background (#0b0e14) it is
 * a low 1.32:1, but the frame is not carrying information on its own —
 * the white arrows (19.3:1) and the red/blue pawns (4.6:1 and 5.3:1)
 * define the shape, and a render against the actual background confirms
 * the tile reads clearly. Raising the frame's contrast would have made
 * it a grey slab competing with the wordmark.
 *
 * TYPEFACE. The <text> inherits the app's own font stack rather than the
 * SVG default of serif — `font-family: inherit` picks up the body font
 * from index.css through the surrounding element, so the wordmark
 * matches every other piece of text on the screen.
 *
 * ACCESSIBILITY. The SVG carries role="img" and its own accessible name.
 * When it is used inside a heading the caller passes `labelledBy`/
 * `decorative` so the name is announced exactly once — see the note on
 * `BrandLogoProps.decorative`.
 */

interface BrandLogoProps {
  /**
   * Rendered height in pixels. Width follows from the artwork's own
   * 460:90 ratio, so the proportions can never be squashed.
   */
  readonly height: number;
  /**
   * Hide the logo from the accessibility tree entirely.
   *
   * Use this when the logo sits inside an element that ALREADY names
   * itself — a heading whose visible text is "Knockout Arena", say.
   * Without it the heading would be announced twice: once for the SVG's
   * own label and once for the heading text.
   */
  readonly decorative?: boolean;
  /** Extra classes for the wrapping <svg>. */
  readonly className?: string;
}

export function BrandLogo({
  height,
  decorative = false,
  className,
}: BrandLogoProps) {
  // 460 × 90 is the artwork's own box; deriving the width keeps the
  // aspect ratio exact at any height.
  const width = (height * 460) / 90;

  // Markers are referenced by id, so two logos on one page would
  // otherwise share (and fight over) a single #koArrowW definition.
  // Only ever rendered once per screen today, but the suffix makes that
  // assumption unnecessary.
  const markerId = decorative ? "koArrowW-dec" : "koArrowW";

  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": "Knockout Arena" } as const);

  return (
    <svg
      viewBox="0 0 460 90"
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      className={className}
      data-testid="brand-logo"
      {...a11y}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path
            d="M2 1L8 5L2 9"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
      <rect
        x="0"
        y="0"
        width="80"
        height="80"
        rx="16"
        fill="#20293a"
        stroke="#2f3b52"
        strokeWidth="2"
      />
      <circle
        cx="31"
        cy="31"
        r="13"
        fill="#e53935"
        stroke="#ffffff"
        strokeWidth="3"
      />
      <circle
        cx="31"
        cy="55"
        r="13"
        fill="#1e88e5"
        stroke="#ffffff"
        strokeWidth="3"
      />
      <line
        x1="40.2"
        y1="40.2"
        x2="67"
        y2="67"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
      <line
        x1="40.2"
        y1="45.8"
        x2="67"
        y2="13"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        markerEnd={`url(#${markerId})`}
      />
      <text
        x="90"
        y="55"
        fontSize="42"
        fontWeight="700"
        fill="#ffffff"
        // The app's own font, not the SVG default serif.
        fontFamily="inherit"
      >
        nockout Arena
      </text>
    </svg>
  );
}
