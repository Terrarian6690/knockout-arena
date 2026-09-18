import { playerColor, type GameStateSnapshot, type PawnSnapshot } from "../../../game";
import { cn } from "../../utils/cn";
import { HostChip, YouChip } from "../lobby/SeatList";

/**
 * The match's player rail: who is playing, who is "you", who hosts, who
 * has locked in their move and who is out — all read from the
 * authoritative snapshot (the server's viewer projection marks your own
 * pawn via `isLocal`; the host id comes from the room state). This is
 * display only: the rail never advances a round or decides an elimination.
 *
 * LAYOUT: a vertical COLUMN down the left edge of the arena, one row per
 * player, each row reading name → pawn look → Host/You badge → status.
 * It used to be a horizontal strip under the header, which pushed the
 * six-player roster into a scrolling row where names were the first
 * thing to be clipped.
 *
 * An eliminated player's row is struck through — the whole line, not
 * just the name — so being out reads at a glance rather than having to
 * be inferred from a dimmed swatch.
 */
interface MatchRailProps {
  readonly snapshot: GameStateSnapshot;
  /** Seat id of the room host, as reported by the server. */
  readonly hostPlayerId: string | null;
}

/**
 * The per-player status word. Kept in the row (it is the only place the
 * viewer can see who has already locked in a move) and deliberately the
 * LAST cell, after the identity cells.
 */
function statusFor(
  pawn: PawnSnapshot,
  phase: GameStateSnapshot["phase"]
): { readonly label: string; readonly className: string } {
  if (pawn.eliminated) return { label: "Out", className: "text-red-300/80" };
  if (phase === "moving") return { label: "Moving", className: "text-sky-300" };
  if (pawn.confirmed) return { label: "Ready", className: "text-emerald-300" };
  return { label: "Choosing…", className: "text-amber-300" };
}

export function MatchRail({ snapshot, hostPlayerId }: MatchRailProps) {
  return (
    <div
      data-testid="match-rail"
      className="flex w-44 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-white/10 bg-white/[0.02] p-2 sm:w-52 sm:p-3"
    >
      {snapshot.pawns.map((pawn) => {
        // Simultaneous rounds: the highlight marks players who are still
        // deciding in the CURRENT round (no single acting pawn).
        const deciding =
          snapshot.phase === "aiming" && !pawn.eliminated && !pawn.confirmed;
        const status = statusFor(pawn, snapshot.phase);
        return (
          <div
            key={pawn.id}
            data-testid={`rail-${pawn.id}`}
            data-eliminated={pawn.eliminated ? "true" : "false"}
            className={cn(
              "flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-xs",
              deciding
                ? "border-amber-400/50 bg-amber-500/10"
                : "border-white/10 bg-white/[0.03]",
              // The whole row reads as struck out when the player is
              // gone: line-through inherits to every cell below, and the
              // dimming reinforces it for anyone who cannot see the line.
              pawn.eliminated && "opacity-45 line-through decoration-red-400/70"
            )}
          >
            {/* Row 1 — the identity line, in the order it is read:
                name, then the pawn's look, then Host/You. */}
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-semibold text-white">
                {pawn.name}
              </span>
              <span
                aria-hidden
                data-testid={`rail-swatch-${pawn.id}`}
                className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/25"
                style={{ backgroundColor: playerColor(pawn.colorIndex) }}
              />
              {pawn.isLocal && <YouChip />}
              {pawn.id === hostPlayerId && <HostChip />}
            </div>

            {/* Row 2 — seat id and the live status word. */}
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-white/50">
                {pawn.id}
              </span>
              <span className={cn("font-semibold", status.className)}>
                {status.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
