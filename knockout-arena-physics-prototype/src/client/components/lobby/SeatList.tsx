import { CONFIG, playerColor } from "../../../game";
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
 * THE LOOK IS THE MATCH RAIL'S: the same one-line tiles the in-round
 * roster uses — a green frame while the player is connected, a red one
 * (and muted text) once they are not — so the lobby list and the match
 * rail read as the same thing in two states of the room.
 *
 * WINS: each tile ends (left of the disc swatch, on the right side of
 * the row) with the number of matches this seat's occupant has won in
 * this room, and the list is SORTED by that count — the biggest winner
 * on top, ties keeping seat order. Everyone tied at the top wears the
 * crown; a room where nobody has won yet keeps plain seat order and no
 * crown. A seat's count follows its OCCUPANT: a freed seat starts the
 * next player from zero (server-side rule).
 *
 * MAX_SEATS mirrors the server's room capacity and MIN_PLAYERS its start
 * rule (both UX mirrors only — the roster stays authoritative and the
 * server validates for real). MAX_SEATS is DERIVED from the engine's
 * CONFIG.match.maxPlayers — the same constant the room manager's
 * MAX_PLAYERS comes from — so the lobby grid cannot drift out of step
 * with real capacity. The wire protocol does not carry the maximum, so
 * we render exactly the seats the server reports and only PAD the
 * visual grid with empty placeholders — if the server ever reported
 * more, they would all be rendered.
 */
export const MAX_SEATS = CONFIG.match.maxPlayers;

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
}

/**
 * The roster decorated for display: wins resolved (absent wire field =
 * zero) and the original seat index kept so equal-win ties stay in seat
 * order. Sorted by wins, DESCENDING.
 */
function rankedRoster(roster: readonly RosterEntry[]): Array<{
  seat: RosterEntry;
  index: number;
  wins: number;
}> {
  return roster
    .map((seat, index) => ({ seat, index, wins: seat.wins ?? 0 }))
    .sort((a, b) => b.wins - a.wins || a.index - b.index);
}

export function SeatList({ roster, selfPlayerId }: SeatListProps) {
  const ranked = rankedRoster(roster);
  // The crown goes to EVERY seat tied at the top — but only when that
  // top is actually a win (a fresh room crowns nobody).
  const best = ranked.length > 0 ? ranked[0]!.wins : 0;
  const crowned = best > 0 ? best : -1;

  const emptySeats = Math.max(0, MAX_SEATS - roster.length);
  return (
    <ul
      data-testid="seat-list"
      // ONE column of full-width rows (each row a horizontal strip:
      // status dot, name, chips, wins, disc) — the pinned layout, so
      // six players read as one tidy stack instead of a wrapped grid.
      className="flex flex-col gap-1.5"
    >
      {ranked.map(({ seat, wins }) => {
        const connected = seat.connected;
        return (
          <li
            key={seat.playerId}
            data-testid={`seat-${seat.playerId}`}
            data-wins={wins}
            // The match rail's tile grammar: green frame while in, red
            // frame (and muted text) once out. The text label below
            // keeps the state from being colour-alone. relative: the
            // wins section is absolutely positioned, so its tripled
            // size NEVER grows the tile — it is fitted to the tile.
            className={cn(
              "relative flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
              connected
                ? "border-emerald-500/60 bg-emerald-500/[0.06]"
                : "border-red-500/70 bg-red-500/[0.07]"
            )}
          >
            {/* The crown leads the row — it sits at the LEFT edge of the
                tile of the player with the most wins. */}
            {wins === crowned && <Crown crownId={seat.playerId} />}
            {/* ALL of the player's info lives in the LEFT ~3/4 of the
                tile; the wins section begins where it ends. */}
            <span
              data-testid={`info-${seat.playerId}`}
              className="flex w-3/4 min-w-0 items-center gap-2"
            >
              <span
                role="img"
                aria-label={connected ? "connected" : "disconnected"}
                title={connected ? "Connected" : "Disconnected"}
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  connected ? "bg-emerald-400" : "bg-red-400/70"
                )}
              />
              <span className="min-w-0 shrink">
                <span
                  className={cn(
                    "block truncate text-xs font-bold leading-tight",
                    connected ? "text-white" : "text-white/50"
                  )}
                >
                  {seat.displayName ?? seatLabel(seat.playerId)}
                </span>
                <span
                  className={cn(
                    "block text-xs leading-tight",
                    connected ? "text-white/50" : "text-red-300/70"
                  )}
                >
                  {connected ? "Connected" : "Disconnected"}
                </span>
              </span>
              {/* The player's DISC SKIN — immediately AFTER the nick: the
                  same palette index the arena renderer paints their pawn
                  with, so the look sits right where the eye just read the
                  name. */}
              <span
                aria-hidden
                data-testid={`skin-swatch-${seat.playerId}`}
                title="Disc skin"
                className="h-3 w-3 shrink-0 rounded-full ring-1 ring-white/25"
                style={{ backgroundColor: playerColor(seat.skin ?? 0) }}
              />
              {seat.playerId === selfPlayerId && <YouChip className="text-xs" />}
            </span>
            {/* The wins section — OUT OF THE FLOW: anchored at the
                ~3/4 mark and centred vertically, so the tripled number
                and trophy are fitted INTO the tile (border to border)
                instead of stretching it. The info group's w-3/4 keeps
                the name area clear of it. */}
            <span
              data-testid={`wins-${seat.playerId}`}
              title={`${wins === 1 ? "1 win" : `${wins} wins`} in this room`}
              aria-label={`${wins === 1 ? "1 win" : `${wins} wins`} in this room`}
              className="absolute left-3/4 top-1/2 flex w-1/4 -translate-y-1/2 items-center gap-2 text-[33px] font-bold leading-none tabular-nums text-white/80"
            >
              {wins}
              <TrophyBadge trophyId={seat.playerId} />
            </span>
          </li>
        );
      })}

      {Array.from({ length: emptySeats }, (_, index) => (
        <li
          key={`empty-seat-${index}`}
          data-testid="empty-seat"
          className="flex items-center rounded-lg border border-dashed border-white/15 px-3 py-2"
        >
          <span
            role="img"
            aria-label="empty seat"
            className="h-2 w-2 shrink-0 rounded-full border border-white/25"
          />
          <span className="ml-2 text-sm leading-tight text-white/50">
            Waiting for player…
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "You" chip — marks the viewer's own pawn (server-reported). */
export function YouChip({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-sky-400/30 bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-300",
        className
      )}
    >
      You
    </span>
  );
}

/**
 * The trophy badge — the wins section of every row ENDS with it: the
 * number before it counts the trophies (match wins) earned in this
 * room. Gold, drawn large to match the tripled counter (a notch under
 * its 33 px cap height, so the two read as one unit).
 */
export function TrophyBadge({ trophyId }: { readonly trophyId: string }) {
  return (
    <svg
      data-testid={`trophy-${trophyId}`}
      aria-hidden="true"
      width="36"
      height="36"
      viewBox="0 0 24 24"
      className="shrink-0"
    >
      {/* Cup bowl with the two side handles. */}
      <path
        d="M7 3.5h10V8a5 5 0 0 1-10 0V3.5z"
        fill="#fbbf24"
        stroke="#f59e0b"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M7 5H4.5a2.75 2.75 0 0 0 2.9 4M17 5h2.5a2.75 2.75 0 0 1-2.9 4"
        fill="none"
        stroke="#f59e0b"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Stem and base. */}
      <path d="M11 12.6h2v2.4h-2z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="0.8" />
      <path
        d="M8.2 16.4h7.6v1.8a1 1 0 0 1-1 1H9.2a1 1 0 0 1-1-1v-1.8z"
        fill="#f59e0b"
      />
    </svg>
  );
}

/**
 * The leader's crown — worn by every seat tied at the top of the win
 * count. Gold, three-spike, drawn to sit at the LEFT edge of the tile,
 * ahead of every other element in the row.
 */
export function Crown({ crownId }: { readonly crownId: string }) {
  return (
    <svg
      data-testid={`crown-${crownId}`}
      role="img"
      aria-label="most wins in the room"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      className="shrink-0 drop-shadow"
    >
      <path
        d="M3 8.5 L7.5 12 L12 5.5 L16.5 12 L21 8.5 L19.2 17.5 H4.8 Z"
        fill="#fbbf24"
        stroke="#f59e0b"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <rect x="4.8" y="18.6" width="14.4" height="1.8" rx="0.9" fill="#fbbf24" />
    </svg>
  );
}
