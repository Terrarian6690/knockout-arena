import { PowerMeter } from "./game/PowerMeter";

/**
 * Power selector (1..5) for the solo practice screen.
 *
 * This is the SAME control the match screen uses — the growing green→red
 * arrow with five discrete points (see game/PowerMeter). Sharing the one
 * component rather than keeping a second look-alike means the two screens
 * cannot drift apart, and the solo screen inherits the accessibility
 * contract it previously lacked: role="group" + aria-label, aria-pressed
 * on the selected level, and arrow-key navigation between the points.
 *
 * The "Weak … Strong" caption stays: the arrow now says the same thing
 * visually, but the words carry it for anyone who cannot see the shape.
 */
interface PowerSelectorProps {
  power: number;
  disabled?: boolean;
  onChange: (power: number) => void;
}

export function PowerSelector({
  power,
  disabled,
  onChange,
}: PowerSelectorProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      <PowerMeter
        power={power}
        disabled={disabled}
        onChange={onChange}
        instanceId="solo"
      />
      <div className="flex items-center gap-2 text-xs text-white/50">
        <span>Weak</span>
        <div className="h-px w-16 bg-white/15" />
        <span>Strong</span>
      </div>
    </div>
  );
}
