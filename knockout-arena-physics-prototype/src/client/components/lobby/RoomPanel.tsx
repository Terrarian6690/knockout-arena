import type { RoomState, RosterEntry } from "../../network/types";
import { cn } from "../../utils/cn";
import { MAX_SEATS, SeatList } from "./SeatList";

/**
 * The waiting-room card: room identity, the seat roster and the room-level
 * actions. Everything displayed is server data — the room id and your seat
 * from the welcome, the roster/host/room state from the server's room_state
 * broadcasts, the winner from match_finished. The panel never derives any
 * of it locally; even "am I the host" is a comparison of two
 * server-reported ids.
 */

const ROOM_STATE_BADGE: Record<RoomState, { label: string; className: string }> = {
  waiting: {
    label: "Waiting for players",
    className: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  },
  playing: {
    label: "Match in progress",
    className: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  },
  finished: {
    label: "Finished",
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  },
};

export interface RoomPanelProps {
  readonly roomId: string;
  readonly playerId: string;
  readonly hostPlayerId: string | null;
  readonly roomState: RoomState;
  readonly roster: readonly RosterEntry[];
  readonly winnerId: string | null;
  /** Local, purely visual: the host's Start click is awaiting the server. */
  readonly startPending: boolean;
  onStart: () => void;
  onLeave: () => void;
}

export function RoomPanel({
  roomId,
  playerId,
  hostPlayerId,
  roomState,
  roster,
  winnerId,
  startPending,
  onStart,
  onLeave,
}: RoomPanelProps) {
  const isHost = hostPlayerId !== null && hostPlayerId === playerId;
  const badge = ROOM_STATE_BADGE[roomState];

  return (
    <div
      data-testid="room-panel"
      className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-white/40">
          Room
        </span>
        <span
          data-testid="room-state-badge"
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-semibold",
            badge.className
          )}
        >
          {badge.label}
        </span>
      </div>

      <div className="mt-3 text-center">
        <div
          data-testid="room-id"
          className="font-mono text-4xl font-black tracking-[0.2em] text-amber-400"
        >
          {roomId}
        </div>
        {roomState === "waiting" && (
          <p className="mt-1 text-xs text-white/40">
            Share this ID so others can join
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-center gap-2 text-xs">
        <span className="text-white/40">You are</span>
        <span
          data-testid="local-player-id"
          className="font-mono text-sm font-bold text-white"
        >
          {playerId}
        </span>
        {isHost && (
          <span className="rounded-full border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">
            Host
          </span>
        )}
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-white/40">
            Players
          </span>
          <span className="text-[11px] tabular-nums text-white/30">
            {roster.length} / {MAX_SEATS}
          </span>
        </div>
        <SeatList
          roster={roster}
          selfPlayerId={playerId}
          hostPlayerId={hostPlayerId}
        />
      </div>

      {roomState === "finished" && (
        <div
          data-testid="match-result"
          className="mt-6 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-4 text-center"
        >
          <div className="text-3xl">🏆</div>
          <p className="mt-1 text-lg font-black text-emerald-300">
            {winnerId ? `${winnerId} wins!` : "No survivor — total knockout!"}
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2">
        {isHost && roomState === "waiting" && (
          <button
            type="button"
            onClick={onStart}
            disabled={startPending}
            data-testid="start-match"
            className={cn(
              "rounded-xl px-7 py-3 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
              "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
              "hover:from-amber-300 hover:to-orange-500 active:scale-95",
              "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            )}
          >
            {startPending ? "Starting…" : "Start Match"}
          </button>
        )}

        {!isHost && roomState === "waiting" && (
          <p
            data-testid="waiting-for-host"
            className="py-1 text-center text-xs text-white/35"
          >
            Waiting for the host to start the match…
          </p>
        )}

        <button
          type="button"
          onClick={onLeave}
          data-testid="leave-room"
          className={cn(
            "rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white/80",
            "transition-colors hover:border-red-400/30 hover:bg-red-500/10 hover:text-red-300 active:scale-95"
          )}
        >
          Leave Room
        </button>
      </div>
    </div>
  );
}
