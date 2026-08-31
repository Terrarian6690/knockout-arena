import { CONFIG } from "../game/config";
import { cn } from "../utils/cn";

/**
 * Power selector (1..5). Each level is a button that fills proportionally to
 * indicate relative strength.
 */
interface PowerSelectorProps {
  power: number;
  disabled?: boolean;
  onChange: (power: number) => void;
}

const POWER_LABELS = ["", "", "", "", ""];

export function PowerSelector({ power, disabled, onChange }: PowerSelectorProps) {
  const { min, max } = CONFIG.power;
  const levels = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-1.5">
        {levels.map((level) => {
          const active = level <= power;
          const isCurrent = level === power;
          return (
            <button
              key={level}
              type="button"
              disabled={disabled}
              onClick={() => onChange(level)}
              aria-label={`Power ${level}`}
              className={cn(
                "group relative flex h-12 w-8 flex-col items-center justify-end overflow-hidden rounded-md border transition-all duration-150",
                "border-white/15 bg-white/[0.04] hover:bg-white/[0.08]",
                "disabled:cursor-not-allowed disabled:opacity-50",
                isCurrent && "ring-2 ring-amber-400/70"
              )}
            >
              {/* Fill bar sized by level */}
              <span
                className={cn(
                  "absolute inset-x-0 bottom-0 transition-all duration-200",
                  active
                    ? "bg-gradient-to-t from-amber-500/90 to-amber-300/70"
                    : "bg-white/10"
                )}
                style={{ height: `${(level / max) * 100}%` }}
              />
              <span
                className={cn(
                  "relative z-10 mb-1 text-sm font-bold",
                  isCurrent ? "text-amber-100" : "text-white/70"
                )}
              >
                {POWER_LABELS[level - 1] || level}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-xs text-white/50">
        <span>Weak</span>
        <div className="h-px w-16 bg-white/15" />
        <span>Strong</span>
      </div>
    </div>
  );
}
