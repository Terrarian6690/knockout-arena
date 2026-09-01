import type { RosterEntry } from "../../network/types";
import { cn } from "../../utils/cn";

/**
 * The room's seat list. Everything shown here comes from the server's
 * roster (seat order, who is host, who left); the only client-side input
 * is which playerId is "you" — itself server-assigned in the welcome.
 *
 * MAX_SEATS mirrors the server's room capacity. The wire protocol does
 * not carry the maximum, so the roster itself stays authoritative: we
 * render exactly the seats the server reports and only PAD the visual
 * grid with empty placeholders — if the server ever reported more, they
 * would all be rendered.
 */
export const MAX_SEATS = 4;

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
              aria-label={seat.connected ? "connected" : "disconnected"}
              title={seat.connected ? "Connected" : "Left the match"}
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                seat.connected ? "bg-emerald-400" : "bg-red-400/70"
              )}
            />
            <span className="font-mono text-sm font-bold text-white">
              {seat.playerId}
            </span>
            {seat.playerId === selfPlayerId && <YouChip />}
            {seat.playerId === hostPlayerId && <HostChip />}
          </div>
          <span className="shrink-0 text-xs text-white/40">
            {seat.connected ? "Ready" : "Left the match"}
          </span>
        </li>
      ))}

      {Array.from({ length: emptySeats }, (_, index) => (
        <li
          key={`empty-seat-${index}`}
          data-testid="empty-seat"
          className="flex items-center justify-between rounded-xl border border-dashed border-white/15 px-4 py-3"
        >
          <span className="text-sm text-white/30">Empty seat</span>
          <span className="text-xs text-white/20">Waiting…</span>
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
