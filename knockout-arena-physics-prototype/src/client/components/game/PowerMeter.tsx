import { CONFIG } from "../../../game";
import { cn } from "../../utils/cn";

/**
 * The multiplayer power meter (1..5) — a horizontal, progressively
 * widening wedge at the bottom of the match screen: green → yellow →
 * orange → red from the weak end to the strong end, so the scale itself
 * communicates "more power, harder launch".
 *
 * Five discrete buttons (integer levels only — no fractional values):
 *   - every level up to the current one is filled with its scale color,
 *     the rest stay dim — the filled run reads as a power gauge;
 *   - the current level carries the ring + bright label;
 *   - heights step up toward the strong end, giving the wedge shape;
 *   - a chevron cap points at the strong end.
 *
 * Each button keeps the accessible name "Power N" (keyboard: Tab / Enter /
 * Space — plain buttons, no custom key handling to drift out of sync).
 * The meter renders disabled (not hidden) once the player has confirmed:
 * the locked choice stays readable while the round resolves.
 */
interface PowerMeterProps {
  /** The power level to display (authoritative, or the pending choice). */
  readonly power: number;
  /** Disabled while the local player cannot act (confirmed/resolving). */
  readonly disabled?: boolean;
  onChange: (power: number) => void;
}

/** Scale colors: green → yellow-green → yellow → orange → red. */
const LEVEL_COLORS: readonly string[] = [
  "#22c55e", // 1 — green
  "#84cc16", // 2 — lime
  "#eab308", // 3 — yellow
  "#f97316", // 4 — orange
  "#ef4444", // 5 — red
];

/** Wedge step: each segment is taller than the one before it. */
const LEVEL_HEIGHTS: readonly number[] = [30, 42, 54, 66, 78];

export function PowerMeter({ power, disabled, onChange }: PowerMeterProps) {
  const { min, max } = CONFIG.power;
  const levels = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <div
      data-testid="power-meter"
      role="group"
      aria-label="Power"
      className="flex select-none items-end"
    >
      {levels.map((level, index) => {
        const filled = level <= power;
        const isCurrent = level === power;
        const color = LEVEL_COLORS[index];
        return (
          <button
            key={level}
            type="button"
            disabled={disabled}
            onClick={() => onChange(level)}
            aria-label={`Power ${level}`}
            aria-pressed={isCurrent}
            data-testid={`power-level-${level}`}
            style={{ height: `${LEVEL_HEIGHTS[index]}px` }}
            className={cn(
              "relative flex w-11 items-end justify-center overflow-visible",
              "border-x border-[#0b0e14] transition-all duration-150",
              "first:rounded-l-md last:rounded-r-md",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              "disabled:cursor-not-allowed",
              !disabled && "hover:brightness-125",
              isCurrent
                ? "z-10 ring-2 ring-white/70"
                : filled
                  ? "ring-1 ring-white/25"
                  : "ring-1 ring-white/10"
            )}
          >
            {/* The fill: the level's scale color when part of the current
                run, a dim slab otherwise — together the row reads as a
                green→red gauge filling up toward the chosen level. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-0 bottom-0 top-1 transition-all duration-200",
                filled ? "opacity-90" : "bg-white/[0.05]"
              )}
              style={filled ? { backgroundColor: color } : undefined}
            />
            <span
              className={cn(
                "relative z-10 mb-1 text-sm font-bold tabular-nums",
                isCurrent
                  ? "text-white"
                  : filled
                    ? "text-black/70"
                    : "text-white/50",
                disabled && "opacity-60"
              )}
            >
              {level}
            </span>
          </button>
        );
      })}
      {/* The wedge's arrowhead — points at the strong end. */}
      <span
        aria-hidden
        data-testid="power-meter-cap"
        className={cn(
          "ml-1 self-center text-lg font-black leading-none",
          disabled ? "text-white/20" : "text-red-400/80"
        )}
      >
        ▸
      </span>
    </div>
  );
}
