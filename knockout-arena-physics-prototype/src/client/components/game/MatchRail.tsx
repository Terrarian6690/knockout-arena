import { playerColor, type GameStateSnapshot } from "../../../game";
import { cn } from "../../utils/cn";
import { HostChip, YouChip } from "../lobby/SeatList";

/**
 * The match's player rail: who is playing, who is "you", who hosts, who
 * acts and who is out — all read from the authoritative snapshot (the
 * server's viewer projection marks your own pawn via `isLocal`; the host
 * id comes from the room state). This is display only: the rail never
 * advances a turn or decides an elimination.
 */
interface MatchRailProps {
  readonly snapshot: GameStateSnapshot;
  /** Seat id of the room host, as reported by the server. */
  readonly hostPlayerId: string | null;
}

export function MatchRail({ snapshot, hostPlayerId }: MatchRailProps) {
  return (
    <div
      data-testid="match-rail"
      className="flex items-center gap-2 overflow-x-auto border-b border-white/10 bg-white/[0.02] px-4 py-2"
    >
      {snapshot.pawns.map((pawn) => {
        const active = pawn.id === snapshot.activePawnId;
        return (
          <div
            key={pawn.id}
            data-testid={`rail-${pawn.id}`}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
              active
                ? "border-amber-400/50 bg-amber-500/10"
                : "border-white/10 bg-white/[0.03]",
              pawn.eliminated && "opacity-45"
            )}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: playerColor(pawn.colorIndex) }}
            />
            <span
              className={cn(
                "font-semibold text-white",
                pawn.eliminated && "line-through decoration-red-400/60"
              )}
            >
              {pawn.name}
            </span>
            <span className="font-mono text-white/35">{pawn.id}</span>
            {pawn.isLocal && <YouChip />}
            {pawn.id === hostPlayerId && <HostChip />}
            {pawn.eliminated ? (
              <span className="font-semibold text-red-300/80">Out</span>
            ) : active ? (
              <span className="font-semibold text-amber-300">
                {snapshot.phase === "moving" ? "Moving" : "Aiming"}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
