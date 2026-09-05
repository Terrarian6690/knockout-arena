import { useEffect, useRef, useState } from "react";
import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
} from "../../network/displayName";
import type { RoomState, RosterEntry } from "../../network/types";
import { cn } from "../../utils/cn";
import { MAX_SEATS, MIN_PLAYERS, SeatList, seatLabel } from "./SeatList";

/**
 * The waiting-room card: room identity, the seat roster and the room-level
 * actions. Everything displayed is server data — the player-facing room
 * code and your seat from the welcome, the roster/host/room state from the
 * server's room_state broadcasts, the winner from match_finished. The
 * panel never derives any of it locally; even "am I the host" is a
 * comparison of two server-reported ids. Seats are shown with each
 * player's chosen display name, or the friendly "Player N" fallback;
 * the internal room id never appears here — players share the
 * 4-character code. The Start
 * button is additionally disabled below MIN_PLAYERS — a UX mirror of the
 * server's own `not-enough-players` rule, never a replacement for it.
 */

/** How long "Copied!" stays visible after a successful copy (ms). */
const COPY_FEEDBACK_MS = 1_600;

/** The app's keyboard-focus ring (same as the game screen's controls). */
const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

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
  /** The player-facing 4-character room code (from the welcome). */
  readonly roomCode: string;
  readonly playerId: string;
  readonly hostPlayerId: string | null;
  readonly roomState: RoomState;
  readonly roster: readonly RosterEntry[];
  readonly winnerId: string | null;
  /** Local, purely visual: the host's Start click is awaiting the server. */
  readonly startPending: boolean;
  /**
   * Whether the network client is connected — while reconnecting (the seat
   * is server-reserved) the Start button is disabled: the send would be a
   * no-op. Optional for direct-use tests; absent means "not disconnected".
   */
  readonly connected?: boolean;
  /**
   * Send this player's own display name (the network client's setName —
   * the server validates and broadcasts; the roster push comes back).
   */
  onSetName: (name: string) => boolean;
  onStart: () => void;
  onLeave: () => void;
}

export function RoomPanel({
  roomCode,
  playerId,
  hostPlayerId,
  roomState,
  roster,
  winnerId,
  startPending,
  connected,
  onSetName,
  onStart,
  onLeave,
}: RoomPanelProps) {
  const isHost = hostPlayerId !== null && hostPlayerId === playerId;
  const badge = ROOM_STATE_BADGE[roomState];
  // UX mirror of the server's start rule (roomManager: MIN_PLAYERS): with
  // fewer seated players the server would reject the start anyway. The
  // button stays visible-but-disabled with a reason; the server remains
  // the authority.
  const enoughPlayers = roster.length >= MIN_PLAYERS;

  // Local, purely visual: whether the code was just copied, plus the timer
  // that reverts the "Copied!" feedback. Cleared on unmount.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const flashCopied = () => {
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopied(false);
      copyTimer.current = null;
    }, COPY_FEEDBACK_MS);
  };

  // ── the local player's display name (own seat only) ────────────────
  const ownSeat = roster.find((entry) => entry.playerId === playerId) ?? null;
  const [nameDraft, setNameDraft] = useState(ownSeat?.displayName ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  // The own name only ever changes through our own Save (or a reconnect
  // restoring the seat) — both arrive while the input is not being
  // edited — so adopting the server's value keeps the input truthful
  // without clobbering anyone's typing.
  useEffect(() => {
    setNameDraft(ownSeat?.displayName ?? "");
  }, [ownSeat?.displayName]);

  const saveName = () => {
    const name = normalizeDisplayName(nameDraft);
    if (name === null) {
      setNameError(
        "Names are 1\u201316 characters — letters, digits, punctuation; no line breaks."
      );
      return;
    }
    setNameError(null);
    onSetName(name); // the server validates again and broadcasts
  };

  const handleCopyCode = async () => {
    try {
      // Prefer the async Clipboard API; fall back to the legacy
      // execCommand path for non-secure contexts (plain http previews).
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomCode);
      } else {
        const helper = document.createElement("textarea");
        helper.value = roomCode;
        helper.setAttribute("readonly", "");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        document.body.removeChild(helper);
      }
      flashCopied();
    } catch {
      // Clipboard unavailable/permission denied — the code stays on
      // screen, big and selectable; showing a false "Copied!" would lie.
    }
  };

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
        <div className="text-[11px] uppercase tracking-widest text-white/40">
          Room code
        </div>
        <div
          data-testid="room-code"
          className="mt-1 font-mono text-4xl font-black tracking-[0.2em] text-amber-400"
        >
          {roomCode}
        </div>
        <div className="mt-2 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={handleCopyCode}
            data-testid="copy-code"
            className={cn(
              "rounded-xl border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-semibold text-white/80 transition-colors",
              "hover:bg-white/10 active:scale-95",
              FOCUS_RING
            )}
          >
            Copy Code
          </button>
          <span
            data-testid="copy-feedback"
            role="status"
            className="text-xs font-semibold text-emerald-300"
          >
            {copied ? "Copied!" : ""}
          </span>
        </div>
        {roomState === "waiting" && (
          <p className="mt-1 text-xs text-white/40">
            Share this code so others can join
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-center gap-2 text-xs">
        <span className="text-white/40">You are</span>
        <span
          data-testid="local-player-id"
          className="text-sm font-bold text-white"
        >
          {seatLabel(playerId)}
        </span>
        {isHost && (
          <span className="rounded-full border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300">
            Host
          </span>
        )}
      </div>

      {roomState === "waiting" && (
        <div className="mt-3">
          <label
            htmlFor="display-name-input"
            className="text-[11px] uppercase tracking-widest text-white/40"
          >
            Your name
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="display-name-input"
              data-testid="display-name-input"
              value={nameDraft}
              onChange={(event) => {
                setNameDraft(event.target.value);
                setNameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveName();
              }}
              placeholder={seatLabel(playerId)}
              // maxLength bounds the UTF-16 units, so 2× the code-point
              // maximum still admits any valid name (surrogate pairs)
              // while keeping pasted novels out of the field.
              maxLength={2 * MAX_DISPLAY_NAME_LENGTH}
              disabled={connected === false}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={nameError !== null}
              className={cn(
                "min-w-0 flex-1 rounded-xl border bg-white/5 px-4 py-2 text-sm text-white outline-none transition-colors",
                "placeholder:text-white/25 focus:border-amber-400/50",
                "disabled:cursor-not-allowed disabled:opacity-40",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                nameError !== null ? "border-red-400/50" : "border-white/15"
              )}
            />
            <button
              type="button"
              onClick={saveName}
              disabled={connected === false || nameDraft.trim().length === 0}
              data-testid="save-name"
              className={cn(
                "rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white/80 transition-colors",
                "hover:bg-white/10 active:scale-95",
                "disabled:cursor-not-allowed disabled:opacity-40",
                FOCUS_RING
              )}
            >
              Save Name
            </button>
          </div>
          {nameError !== null && (
            <p data-testid="name-error" role="alert" className="mt-2 text-xs text-red-300">
              {nameError}
            </p>
          )}
          <p className="mt-1 text-[11px] text-white/30">
            1–16 characters; leave empty to stay {seatLabel(playerId)}.
          </p>
        </div>
      )}

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-widest text-white/40">
            Players
          </span>
          <span
            data-testid="player-count"
            aria-label={`${roster.length} of ${MAX_SEATS} players`}
            className="text-[11px] tabular-nums text-white/30"
          >
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
            {winnerId
              ? `${
                  roster.find((entry) => entry.playerId === winnerId)
                    ?.displayName ?? seatLabel(winnerId)
                } wins!`
              : "No survivor — total knockout!"}
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2">
        {isHost && roomState === "waiting" && (
          <>
            <button
              type="button"
              onClick={onStart}
              disabled={
                startPending || connected === false || !enoughPlayers
              }
              data-testid="start-match"
              className={cn(
                "rounded-xl px-7 py-3 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
                "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
                "hover:from-amber-300 hover:to-orange-500 active:scale-95",
                "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
                FOCUS_RING
              )}
            >
              {startPending ? "Starting…" : "Start Match"}
            </button>
            {!enoughPlayers && (
              <p
                data-testid="waiting-for-players"
                className="text-center text-xs text-white/35"
              >
                Waiting for another player…
              </p>
            )}
          </>
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
            "transition-colors hover:border-red-400/30 hover:bg-red-500/10 hover:text-red-300 active:scale-95",
            FOCUS_RING
          )}
        >
          Leave Room
        </button>
      </div>
    </div>
  );
}
