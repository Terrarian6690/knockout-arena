import { useEffect, useRef, useState } from "react";
import { playerColor, playerStroke, PLAYER_COLORS } from "../../../game";
import { cn } from "../../utils/cn";
import { skinChoices, skinName, type SkinChoice } from "./skins";

/**
 * The disc-skin picker — a small button showing the CURRENT choice (the
 * requirement: the selected skin is displayed on the button), which
 * opens a compact menu of all available skins.
 *
 * `value === null` is the DEFAULT "Random" choice: your skin will be
 * dealt by the server when you join a room or a public game — drawn
 * from the palette, skipping colors the already-seated players wear —
 * so until then the button shows the random marker (a pie of every
 * palette color) instead of any single disc.
 *
 * Pure presentation + persistence is the CALLER's job: this component
 * reports the choice through onChange and renders `value`.
 */
export function SkinPicker({
  value,
  onChange,
  disabled = false,
}: {
  /** The currently selected skin, or null for the random default. */
  readonly value: SkinChoice;
  onChange: (skin: SkinChoice) => void;
  /** Disabled while disconnected (the choice still applies later). */
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape and on any click outside the picker.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* The trigger — it IS the current choice's preview. */}
      <button
        type="button"
        data-testid="skin-picker"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Disc skin: ${skinName(value)}. Change skin`}
        title={`Disc skin: ${skinName(value)}`}
        className={cn(
          "flex h-[38px] items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-2.5 transition-colors",
          "hover:border-white/30 hover:bg-white/10",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
          "disabled:cursor-not-allowed disabled:opacity-40"
        )}
      >
        {value === null ? (
          <RandomDisc size={20} />
        ) : (
          <DiscSwatch skin={value} size={20} />
        )}
        <span
          aria-hidden="true"
          className="text-[9px] leading-none text-white/50"
        >
          ▲▼
        </span>
      </button>

      {open && (
        <div
          data-testid="skin-menu"
          role="menu"
          aria-label="Choose a disc skin"
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex gap-1.5 rounded-xl border border-white/15 bg-slate-900/95 p-2 shadow-xl backdrop-blur"
        >
          {/* The RANDOM choice first — it is the default. */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === null}
            aria-label={skinName(null)}
            title={skinName(null)}
            data-testid="skin-option-random"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(
              "rounded-lg border p-1 transition-colors",
              value === null
                ? "border-white/70 bg-white/10"
                : "border-transparent hover:border-white/25 hover:bg-white/5",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            )}
          >
            <RandomDisc size={24} />
          </button>
          {skinChoices().map((choice) => (
            <button
              key={choice.index}
              type="button"
              role="menuitemradio"
              aria-checked={choice.index === value}
              aria-label={choice.name}
              title={choice.name}
              data-testid={`skin-option-${choice.index}`}
              onClick={() => {
                onChange(choice.index);
                setOpen(false);
              }}
              className={cn(
                "rounded-lg border p-1 transition-colors",
                choice.index === value
                  ? "border-white/70 bg-white/10"
                  : "border-transparent hover:border-white/25 hover:bg-white/5",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              )}
            >
              <DiscSwatch skin={choice.index} size={24} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One disc, drawn exactly like the renderer draws a pawn: colored body,
 * lighter outline, top-left specular highlight.
 */
export function DiscSwatch({ skin, size }: { readonly skin: number; readonly size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="block"
    >
      <circle cx="12" cy="12" r="10" fill={playerColor(skin)} stroke={playerStroke(skin)} strokeWidth="2" />
      <circle cx="8.4" cy="8.4" r="3.4" fill="rgba(255,255,255,0.35)" />
    </svg>
  );
}

/**
 * The RANDOM marker: a disc sliced into one wedge per palette color —
 * "any of these". Drawn as pie slices of the same 24×24 viewBox.
 */
export function RandomDisc({ size }: { readonly size: number }) {
  const cx = 12;
  const cy = 12;
  const r = 10;
  const wedge = (from: number, to: number) => {
    // SVG arcs from angle a1 to a2 (radians, 0 = 12 o'clock, clockwise).
    const pt = (a: number) => ({
      x: cx + r * Math.sin(a),
      y: cy - r * Math.cos(a),
    });
    const p1 = pt(from);
    const p2 = pt(to);
    return `M ${cx} ${cy} L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} Z`;
  };
  const step = (Math.PI * 2) / PLAYER_COLORS.length;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="block"
    >
      {PLAYER_COLORS.map((color, index) => (
        <path
          key={color}
          d={wedge(index * step, (index + 1) * step)}
          fill={color}
        />
      ))}
      <circle cx="12" cy="12" r="10" fill="none" stroke={playerStroke(0)} strokeWidth="2" />
    </svg>
  );
}
