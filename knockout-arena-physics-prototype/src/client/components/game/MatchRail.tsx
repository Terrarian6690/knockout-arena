import { playerColor, type GameStateSnapshot } from "../../../game";
import { cn } from "../../utils/cn";
import { YouChip } from "../lobby/SeatList";

/**
 * The match's player rail: who is playing, who is "you", and who is out
 * — read from the authoritative snapshot (the server's viewer projection
 * marks your own pawn via `isLocal`). Display only: the rail never
 * advances a round or decides an elimination.
 *
 * ONE LINE PER PLAYER. Name, then the pawn's colour swatch, then the You
 * badge — nothing else. The seat id ("p0"), the Host chip and the
 * per-round status word ("Ready" / "Choosing…") were all dropped: they
 * forced a second row per tile and the roster is glanced at, not read.
 *
 * THE BORDER CARRIES THE STATE. Green while the player is alive and in
 * the match, red once they are out — and an eliminated tile also greys
 * its contents and strikes them through, so the fact survives both a
 * colour-blind viewer and a quick glance.
 *
 * NOTE ON "or left the game": a red border currently means ELIMINATED.
 * The match snapshot carries no per-pawn connection flag — that lives in
 * the lobby's seat list, not in the game projection — so a player who
 * closes their tab is not distinguishable here yet. Wiring that through
 * the protocol is a separate change.
 */
interface MatchRailProps {
  readonly snapshot: GameStateSnapshot;
  /**
   * How this room was entered. Titles the roster so the player can see
   * at a glance whether they are in a code-shared game with friends or
   * a matchmade one with strangers. Null (unknown / older server) falls
   * back to the neutral "Players".
   */
  readonly roomVisibility?: "public" | "private" | null;
  /**
   * Seat id of the room host. No longer rendered (the Host chip was
   * dropped from the rail) but kept in the props so callers — and the
   * lobby, which still shows it — need no change.
   */
  readonly hostPlayerId?: string | null;
}

export function MatchRail({ snapshot, roomVisibility }: MatchRailProps) {
  const title =
    roomVisibility === "private"
      ? "Private game"
      : roomVisibility === "public"
        ? "Multiplayer match"
        : "Players";
  return (
    <div
      data-testid="match-rail"
      className="flex w-44 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-white/10 bg-white/[0.02] p-2 sm:w-52 sm:p-3"
    >
      {/* The roster's title, in place of the subtitle that used to sit
          under the logo. Bigger than the tiles it heads, because it is
          naming the whole game you are in. */}
      <h2
        data-testid="match-rail-title"
        className="px-0.5 pb-1 text-sm font-bold tracking-tight text-white"
      >
        {title}
      </h2>
      {snapshot.pawns.map((pawn) => {
        const out = pawn.eliminated;
        return (
          <div
            key={pawn.id}
            data-testid={`rail-${pawn.id}`}
            data-eliminated={out ? "true" : "false"}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
              out
                ? // Out: red frame, greyed and struck through.
                  "border-red-500/70 bg-red-500/[0.07] line-through decoration-red-400 decoration-2"
                : // Alive and connected: green frame.
                  "border-emerald-500/60 bg-emerald-500/[0.06]"
            )}
          >
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-semibold",
                out ? "text-white/40" : "text-white"
              )}
            >
              {pawn.name}
            </span>
            <span
              aria-hidden
              data-testid={`rail-swatch-${pawn.id}`}
              className={cn(
                "h-3 w-3 shrink-0 rounded-full ring-1",
                out ? "opacity-40 ring-white/15" : "ring-white/25"
              )}
              style={{
                // Greyed out when eliminated: the pawn's colour stops
                // mattering once it is off the board.
                backgroundColor: out ? "#6b7280" : playerColor(pawn.colorIndex),
              }}
            />
            {pawn.isLocal && <YouChip />}
          </div>
        );
      })}
    </div>
  );
}
