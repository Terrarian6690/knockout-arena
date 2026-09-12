import { CONFIG } from "../../../game";
import { cn } from "../../utils/cn";

/**
 * The multiplayer power meter (1..5) — a horizontal gradient ARROW at the
 * bottom of the match screen, pointing from the weak end toward the
 * strong end: the shaft runs green → lime → yellow → orange → red and
 * the arrowhead tip sits at power 5, so the shape itself reads as
 * "more power, harder launch".
 *
 * Five discrete buttons (integer levels only — no fractional values):
 *   - the five segments share one continuous gradient shaft with visible
 *     dividers and numbered chips, so all levels read as one scale;
 *   - the selected level is unmissable: a white ring, a brightened
 *     segment and an inverted (white) number chip;
 *   - the arrowhead tip marks the strong end (power 5).
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

/** The shaft's gradient stops: green → lime → yellow → orange → red. */
const SHAFT_GRADIENT =
  "linear-gradient(to right, #22c55e, #84cc16, #eab308, #f97316, #ef4444)";

/** The arrowhead tip color: the strong end of the scale (power 5). */
const TIP_COLOR = "#ef4444";

export function PowerMeter({ power, disabled, onChange }: PowerMeterProps) {
  const { min, max } = CONFIG.power;
  const levels = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <div
      data-testid="power-meter"
      role="group"
      aria-label="Power"
      className={cn(
        "flex select-none items-center",
        disabled && "opacity-60 saturate-50"
      )}
    >
      {/* The shaft: one continuous gradient behind the five level buttons. */}
      <div
        className="flex rounded-l-md ring-1 ring-white/20"
        style={{ background: SHAFT_GRADIENT }}
      >
        {levels.map((level) => {
          const isCurrent = level === power;
          return (
            <button
              key={level}
              type="button"
              disabled={disabled}
              onClick={() => onChange(level)}
              aria-label={`Power ${level}`}
              aria-pressed={isCurrent}
              data-testid={`power-level-${level}`}
              className={cn(
                "relative flex h-12 w-12 items-center justify-center",
                "border-l border-white/25 first:border-l-0 first:rounded-l-md",
                "transition-all duration-150",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:z-20",
                "disabled:cursor-not-allowed",
                !disabled && !isCurrent && "hover:brightness-110",
                isCurrent && "z-10 ring-2 ring-white/90 brightness-110"
              )}
            >
              {/* Selected-segment wash: brightens the gradient under the chip. */}
              {isCurrent && (
                <span aria-hidden className="absolute inset-0 bg-white/25" />
              )}
              {/* The number chip: readable on every gradient stop, inverted
                  when selected so the choice is obvious at a glance. */}
              <span
                className={cn(
                  "relative z-10 rounded px-1.5 py-0.5 text-sm font-bold tabular-nums",
                  isCurrent
                    ? "bg-white text-black shadow"
                    : "bg-black/35 text-white"
                )}
              >
                {level}
              </span>
            </button>
          );
        })}
      </div>
      {/* The arrowhead — the tip of the scale (power 5). */}
      <span
        aria-hidden
        data-testid="power-meter-cap"
        className="h-0 w-0 border-y-[24px] border-l-[18px] border-y-transparent"
        style={{ borderLeftColor: TIP_COLOR }}
      />
    </div>
  );
}
