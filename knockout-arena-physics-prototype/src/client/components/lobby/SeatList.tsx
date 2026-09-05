import type { RosterEntry } from "../../network/types";
import { cn } from "../../utils/cn";

/**
 * The room's seat list. Everything shown here comes from the server's
 * roster (seat order, names, who is host, who is connected, who left);
 * the only client-side input is which playerId is "you" — itself
 * server-assigned in the welcome. Each seat shows the player's chosen
 * display name when they set one, and the seat-derived "Player N"
 * fallback otherwise.
 *
 * MAX_SEATS mirrors the server's room capacity and MIN_PLAYERS its start
 * rule (both UX mirrors only — the roster stays authoritative and the
 * server validates for real). The wire protocol does not carry the
 * maximum, so we render exactly the seats the server reports and only
 * PAD the visual grid with empty placeholders — if the server ever
 * reported more, they would all be rendered.
 */
export const MAX_SEATS = 4;

/**
 * The minimum number of players the SERVER requires to start a match
 * (mirrors the room manager's rule: fewer seated players are rejected as
 * `not-enough-players`). Used purely to disable the Start button early
 * and explain why — never as the source of truth.
 */
export const MIN_PLAYERS = 2;

/**
 * Human-friendly seat label: "Player 1" for "p0", "Player 2" for "p1" —
 * the same naming the server itself assigns to the engine's pawns, so
 * the lobby and the match screen speak the same language. Falls back to
 * the raw id for non-standard ids (this server never sends those).
 */
export function seatLabel(playerId: string): string {
  const match = /^p(\d+)$/.exec(playerId);
  return match === null ? playerId : `Player ${Number(match[1]) + 1}`;
}

export interface SeatListProps {
  readonly roster: readonly RosterEntry[];
  /** This client's server-assigned seat id. */
  readonly selfPlayerId: string;
  /** The room host's seat id, as reported by the server. */
  readonly hostPlayerId: string | null;
}

export function SeatList({ roster, selfPlayerId, hostPlayerId }: SeatListProps) {
  const emptySeats = Math.max(0, MAX_SEATS - roster.length);
  return (
    <ul data-testid="seat-list" className="flex flex-col gap-2">
      {roster.map((seat) => (
        <li
          key={seat.playerId}
          data-testid={`seat-${seat.playerId}`}
          className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              role="img"
              aria-label={seat.connected ? "connected" : "disconnected"}
              title={seat.connected ? "Connected" : "Disconnected"}
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                seat.connected ? "bg-emerald-400" : "bg-red-400/70"
              )}
            />
            <span className="text-sm font-bold text-white">
              {seat.displayName ?? seatLabel(seat.playerId)}
            </span>
            {seat.playerId === selfPlayerId && <YouChip />}
            {seat.playerId === hostPlayerId && <HostChip />}
          </div>
          <span
            className={cn(
              "shrink-0 text-xs",
              seat.connected ? "text-white/40" : "text-red-300/70"
            )}
          >
            {seat.connected ? "Connected" : "Disconnected"}
          </span>
        </li>
      ))}

      {Array.from({ length: emptySeats }, (_, index) => (
        <li
          key={`empty-seat-${index}`}
          data-testid="empty-seat"
          className="flex items-center rounded-xl border border-dashed border-white/15 px-4 py-3"
        >
          <span
            role="img"
            aria-label="empty seat"
            className="h-2 w-2 shrink-0 rounded-full border border-white/25"
          />
          <span className="ml-2 text-sm text-white/30">
            Waiting for player…
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "You" chip — marks the viewer's own pawn (server-reported). */
export function YouChip() {
  return (
    <span className="rounded-full border border-sky-400/30 bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-300">
      You
    </span>
  );
}

/** "Host" chip — marks the server-reported room host. */
export function HostChip() {
  return (
    <span className="rounded-full border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">
      Host
    </span>
  );
}
