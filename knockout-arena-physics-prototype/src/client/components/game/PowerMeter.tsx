import { useRef } from "react";
import { CONFIG } from "../../../game";
import { cn } from "../../utils/cn";

/**
 * The power selector (1..5) — a horizontal arrow that GROWS from tail to
 * head, filled with a continuous green → red gradient: thin and green at
 * power 1, wide and red at the arrowhead tip at power 5. The shape itself
 * carries the meaning ("bigger = stronger"), so the scale reads at a
 * glance even before the numbers are.
 *
 * It stays a DISCRETE five-value control, never a continuous slider:
 * exactly five buttons, integer levels only, one per power. The arrow is
 * the backdrop; the five points sit on it.
 *
 * Why SVG rather than CSS: the widening wedge plus arrowhead is one
 * polygon, and a single <linearGradient> spans the whole shape so the
 * colour at each point is genuinely continuous across the wedge (CSS
 * borders can fake a triangle but cannot carry a gradient through it,
 * which is why the previous version needed a separately coloured cap
 * that could drift from the shaft's gradient).
 *
 * ACCESSIBILITY CONTRACT (unchanged from the previous design — the
 * visual changed completely, the behaviour did not):
 *   - role="group" + aria-label="Power" on the container;
 *   - five native <button type="button"> children, accessible name
 *     "Power N", so Tab/Enter/Space work by construction;
 *   - aria-pressed reflects the selected level (exactly one true);
 *   - ADDITIONALLY (new, strictly a gain): Left/Right/Up/Down/Home/End
 *     move between levels as a roving-tabindex toolbar would, which is
 *     what a sighted keyboard user expects from a slider-shaped control.
 *     Tab still reaches every button when no level is focused, so the
 *     old keyboard path is preserved, not replaced.
 *   - the selected level is indicated by more than colour: a white
 *     outlined marker, an inverted (white) number chip, and a raised
 *     position — plus the numeric readout beside the control.
 *
 * Disabled renders the control dimmed but READABLE (not hidden), so the
 * locked-in choice stays visible while the round resolves.
 */
interface PowerMeterProps {
  /** The power level to display (authoritative, or the pending choice). */
  readonly power: number;
  /** Disabled while the local player cannot act (confirmed/resolving). */
  readonly disabled?: boolean;
  onChange: (power: number) => void;
  /**
   * Distinguishes multiple instances in one document. The SVG gradient
   * needs a unique id per instance, or a second meter would reference
   * the first one's <defs> (and vanish if that one unmounts).
   */
  readonly instanceId?: string;
}

/**
 * The gradient stops, weak → strong. Green (safe/gentle) through amber
 * to red (danger/max) is the same semantic ramp the rest of the UI uses
 * for "fine → warning → critical", so the colours mean here what they
 * mean elsewhere.
 */
const GRADIENT_STOPS: ReadonlyArray<{ offset: string; color: string }> = [
  { offset: "0%", color: "#22c55e" }, // green-500  — power 1, weakest
  { offset: "25%", color: "#84cc16" }, // lime-500
  { offset: "50%", color: "#eab308" }, // yellow-500 — power 3, middle
  { offset: "75%", color: "#f97316" }, // orange-500
  { offset: "100%", color: "#ef4444" }, // red-500   — power 5, strongest
];

// ── the arrow's geometry, in SVG user units ─────────────────────────
// One viewBox the whole control is laid out in; the SVG scales to its
// container, so these are proportions, not pixels.
const VIEW_W = 300;
const VIEW_H = 72;
const MID_Y = VIEW_H / 2;
/** Half-height of the shaft at the tail (power 1) and at the head. */
const TAIL_HALF = 7;
const HEAD_HALF = 22;
/** Where the shaft ends and the arrowhead begins. */
const SHAFT_END_X = 244;
/** Half-height of the arrowhead's back edge (the barbs). */
const BARB_HALF = 33;
/** The five points sit on the shaft, inset from both ends. */
const FIRST_X = 26;
const LAST_X = 222;

/** The x centre of level `index` (0-based) along the shaft. */
function pointX(index: number, count: number): number {
  if (count <= 1) return FIRST_X;
  return FIRST_X + ((LAST_X - FIRST_X) * index) / (count - 1);
}

/** The shaft's half-height at a given x — the wedge widens linearly. */
function halfHeightAt(x: number): number {
  const t = Math.min(1, Math.max(0, x / SHAFT_END_X));
  return TAIL_HALF + (HEAD_HALF - TAIL_HALF) * t;
}

export function PowerMeter({
  power,
  disabled,
  onChange,
  instanceId = "default",
}: PowerMeterProps) {
  const { min, max } = CONFIG.power;
  const levels = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Arrow-key navigation across the five points. Moving focus also
   * SELECTS, which is the expected behaviour for a single-select group
   * of this shape (and matches how a slider behaves), so a keyboard user
   * never has to press Enter separately. Enter/Space still work: these
   * are ordinary buttons.
   */
  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = Math.min(levels.length - 1, index + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = Math.max(0, index - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = levels.length - 1;
        break;
      default:
        return; // not ours: let Tab/Enter/Space behave natively
    }
    event.preventDefault();
    if (next === index) return;
    onChange(levels[next]!);
    buttonRefs.current[next]?.focus();
  };

  // Stable across renders (the fill reference must keep resolving) and
  // unique per instance (two meters must not share one <defs> entry).
  const gradientId = `power-arrow-gradient-${instanceId}`;

  const arrowPoints = [
    `0,${MID_Y - TAIL_HALF}`,
    `${SHAFT_END_X},${MID_Y - HEAD_HALF}`,
    `${SHAFT_END_X},${MID_Y - BARB_HALF}`,
    `${VIEW_W},${MID_Y}`,
    `${SHAFT_END_X},${MID_Y + BARB_HALF}`,
    `${SHAFT_END_X},${MID_Y + HEAD_HALF}`,
    `0,${MID_Y + TAIL_HALF}`,
  ].join(" ");

  return (
    <div
      data-testid="power-meter"
      role="group"
      aria-label="Power"
      className={cn(
        "relative select-none",
        // A fixed aspect box: the SVG and the buttons share one
        // coordinate space, so the points always sit on the arrow.
        "h-14 w-full max-w-[208px] sm:h-16 sm:w-[300px] sm:max-w-full",
        disabled && "opacity-60 saturate-50"
      )}
    >
      <svg
        aria-hidden="true"
        data-testid="power-arrow"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
      >
        <defs>
          {/* One gradient across the WHOLE arrow, so the colour at each
              power point is a real sample of one continuous ramp. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            {GRADIENT_STOPS.map((stop) => (
              <stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={stop.color}
              />
            ))}
          </linearGradient>
        </defs>
        <polygon
          data-testid="power-arrow-shape"
          points={arrowPoints}
          fill={`url(#${gradientId})`}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>

      {/* The five discrete points. Positioned in percentages of the same
          viewBox the arrow uses, so each sits exactly on the shaft. */}
      {levels.map((level, index) => {
        const isCurrent = level === power;
        const x = pointX(index, levels.length);
        // The marker grows with the shaft so it always fits inside it.
        const size = Math.round(halfHeightAt(x) * 1.5);
        return (
          <button
            key={level}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            disabled={disabled}
            onClick={() => onChange(level)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            aria-label={`Power ${level}`}
            aria-pressed={isCurrent}
            data-testid={`power-level-${level}`}
            style={{
              left: `${(x / VIEW_W) * 100}%`,
              width: `${size}px`,
              height: `${size}px`,
            }}
            className={cn(
              "absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2",
              "items-center justify-center rounded-full",
              "text-xs font-bold tabular-nums leading-none transition-all duration-150",
              "focus:outline-none focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-white/90",
              "disabled:cursor-not-allowed",
              isCurrent
                ? // Selected: inverted chip + white ring + lifted above
                  // its neighbours. Never colour alone.
                  "z-10 scale-125 bg-white text-black shadow-lg ring-2 ring-white"
                : "bg-black/45 text-white ring-1 ring-white/40",
              !disabled && !isCurrent && "hover:bg-black/60 hover:ring-white/70"
            )}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
