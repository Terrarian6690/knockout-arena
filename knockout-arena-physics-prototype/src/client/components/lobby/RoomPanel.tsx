import { useEffect, useRef, useState } from "react";
import type { RoomState, RoomVisibility, RosterEntry } from "../../network/types";
import { cn } from "../../utils/cn";
import { AutoStartCountdown } from "./AutoStartCountdown";
import { copyTextToClipboard, getInviteUrl } from "./invite";
import { AnimatedEllipsis, WaitingIndicator } from "./WaitingIndicator";
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

/**
 * The Web Share API surface (not in every browser's typings): `share`
 * opens the OS share sheet and rejects with an AbortError when the user
 * dismisses it.
 */
type WebShareNavigator = Navigator & {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
};

/** Whether a failed share() is just the user dismissing the sheet. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

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
  onStart: () => void;
  /**
   * "public" for a matchmade room, "private" for a code-shared one.
   * Presentation only: it changes the WORDING of the waiting hint, never
   * who may start or join.
   */
  roomVisibility?: RoomVisibility | null;
  /**
   * PUBLIC ROOMS (Task 28): the server's absolute automatic-start
   * timestamp, or null when no countdown is armed. Purely displayed —
   * the panel derives no durations and starts nothing.
   */
  autoStartDeadline?: number | null;
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
  onStart,
  roomVisibility,
  autoStartDeadline,
}: RoomPanelProps) {
  const isHost = hostPlayerId !== null && hostPlayerId === playerId;
  const badge = ROOM_STATE_BADGE[roomState];
  // UX mirror of the server's start rule (roomManager: MIN_PLAYERS): with
  // fewer seated players the server would reject the start anyway. The
  // button stays visible-but-disabled with a reason; the server remains
  // the authority.
  const enoughPlayers = roster.length >= MIN_PLAYERS;
  const isPublic = roomVisibility === "public";

  // Local, purely visual: whether the code was just copied, plus the timer
  // that reverts the "Copied!" feedback. Cleared on unmount.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  // Local, purely visual: the Invite button's one-shot feedback (success
  // or failure), with the same short-lived timer. Cleared on unmount.
  const [inviteFeedback, setInviteFeedback] = useState<{
    message: string;
    ok: boolean;
  } | null>(null);
  const inviteTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (inviteTimer.current !== null)
        window.clearTimeout(inviteTimer.current);
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

  const flashInviteFeedback = (message: string, ok: boolean) => {
    setInviteFeedback({ message, ok });
    if (inviteTimer.current !== null)
      window.clearTimeout(inviteTimer.current);
    inviteTimer.current = window.setTimeout(() => {
      setInviteFeedback(null);
      inviteTimer.current = null;
    }, COPY_FEEDBACK_MS);
  };

  const handleCopyCode = async () => {
    // The code stays on screen, big and selectable; only a real success
    // flashes "Copied!" — a false claim would lie.
    if (await copyTextToClipboard(roomCode)) flashCopied();
  };

  const handleInvite = async () => {
    const url = getInviteUrl(roomCode);
    if (url === null) {
      flashInviteFeedback("Couldn't share invite", false);
      return;
    }
    // The Web Share API (mobile browsers, share-sheet desktops) when the
    // browser offers it; otherwise the invite link goes on the clipboard.
    const nav = navigator as WebShareNavigator;
    if (typeof nav.share === "function") {
      try {
        await nav.share({
          title: "Knockout Arena",
          text: `Join my Knockout Arena room! Code: ${roomCode}`,
          url,
        });
        flashInviteFeedback("Shared!", true);
      } catch (error) {
        // A dismissed share sheet is not an error — stay silent. Anything
        // else is honest failure feedback; the code is still on screen.
        if (isAbortError(error)) return;
        flashInviteFeedback("Couldn't share invite", false);
      }
      return;
    }
    if (await copyTextToClipboard(url)) {
      flashInviteFeedback("Link copied!", true);
    } else {
      flashInviteFeedback("Couldn't share invite", false);
    }
  };

  return (
    <div className="w-full max-w-2xl">
      {/* The room's status line lives ABOVE the panel: the player reads
          what the room is doing before the details of it. While waiting
          the three dots animate (reduced motion keeps them static); the
          settled states are a plain badge, since nothing is pending. */}
      {roomState === "waiting" ? (
        <WaitingIndicator
          testId="room-state-badge"
          label={badge.label}
          className="mb-2"
        />
      ) : (
        <p
          data-testid="room-state-badge"
          role="status"
          className={cn(
            "mb-2 rounded-full border px-3 py-1 text-center text-xs font-semibold",
            badge.className
          )}
        >
          {badge.label}
        </p>
      )}

      <div
        data-testid="room-panel"
        className="w-full rounded-2xl border border-white/10 bg-white/[0.02] p-3 sm:p-4"
      >
        {/* The panel's top line. The HOST indicator sits in the top-RIGHT
            corner — the slot the room-state badge used to occupy; that
            badge is now the status banner ABOVE this panel, so the room's
            state is read before its details. */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-widest text-white/50">
            Room
          </span>
          {/* The HOST badge means exactly one thing to a player: "you are
              the one who starts the match". In a PUBLIC room nobody
              starts the match any more (Task 28) — the server does — so
              the badge would advertise an authority that no longer
              exists. Private rooms, where the host really does hold the
              start button, are unchanged. (Host SUCCESSION still runs
              server-side for both kinds of room; it is simply not
              player-facing here.) */}
          {isHost && !isPublic && (
            <span
              data-testid="host-badge"
              className="rounded-full border border-amber-400/30 bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-300"
            >
              Host
            </span>
          )}
        </div>

        {/* PUBLIC rooms have no shareable identity (Task 17 made their code
            unusable via the join field), so showing a code and an invite
            link here would hand the player a link that cannot work. They
            get a plain label instead; private rooms are unchanged. */}
        {isPublic ? (
          <div className="mt-1 text-center">
            <div className="text-[11px] uppercase tracking-widest text-white/50">
              Public game
            </div>
            <div
              data-testid="public-room-label"
              className="text-lg font-bold tracking-tight text-sky-300"
            >
              Quick Play
            </div>
          </div>
        ) : (
        <div className="mt-1 text-center">
          {/* The room code is the one thing a player must read off the
              screen and type or dictate elsewhere, so it is the largest
              text in the lobby. */}
          <div
            data-testid="room-code"
            // The visible caption was dropped to save vertical space; the
            // label lives on the element itself so the code is still
            // announced as "Room code" rather than four bare letters.
            aria-label={`Room code ${roomCode}`}
            className="font-mono text-5xl font-black leading-none tracking-[0.2em] text-amber-400"
          >
            {roomCode}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
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
            {/* Invite is the action that actually fills the room, so it is
                the prominent one here: a filled emerald button against the
                outlined Copy Code. Emerald is the design system's existing
                "success / positive outcome" colour (match result, copy
                confirmation, connected seats) and is not used by any other
                button, so it reads as distinct without inventing a hue. */}
            <button
              type="button"
              onClick={handleInvite}
              data-testid="invite-button"
              className={cn(
                "rounded-xl px-4 py-1.5 text-xs font-bold uppercase tracking-wide shadow-md transition-all",
                "bg-gradient-to-br from-emerald-400 to-teal-600 text-white",
                "hover:from-emerald-300 hover:to-teal-500 active:scale-95",
                "shadow-emerald-900/40",
                FOCUS_RING
              )}
            >
              Invite
            </button>
            <span
              data-testid="copy-feedback"
              role="status"
              className="text-xs font-semibold text-emerald-300"
            >
              {copied ? "Copied!" : ""}
            </span>
            <span
              data-testid="invite-feedback"
              role="status"
              className={cn(
                "text-xs font-semibold",
                inviteFeedback?.ok === false
                  ? "text-red-300"
                  : "text-emerald-300"
              )}
            >
              {inviteFeedback?.message ?? ""}
            </span>
          </div>
          {roomState === "waiting" && (
            <p className="text-[11px] leading-tight text-white/50">
              Share this code so others can join
            </p>
          )}
        </div>
        )}

        {/* The HOST indicator is NOT repeated here: it sits in the
            panel's top-right corner (and on your own seat row). The
            "You are pN" line that used to sit here was removed on
            request — your own row in the seat list is already marked
            with the You badge, which says the same thing once. */}

        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between leading-tight">
            <span className="text-[11px] uppercase tracking-widest text-white/50">
              Players
            </span>
            <span
              data-testid="player-count"
              aria-label={`${roster.length} of ${MAX_SEATS} players`}
              className="text-[11px] tabular-nums text-white/50"
            >
              {roster.length} / {MAX_SEATS}
            </span>
          </div>
          <SeatList
            roster={roster}
            selfPlayerId={playerId}
            /* Public rooms show no host marker at all (Task 28): with no
               host-started match, "Host" would label an authority that
               does not exist there. Passing null keeps SeatList itself
               free of visibility rules. */
            hostPlayerId={isPublic ? null : hostPlayerId}
          />
        </div>

        {roomState === "finished" && (
          /* A DRAW is not a victory (Task 29): with no winner this used
             to render the trophy in the same emerald "someone won"
             frame. The verdict is unchanged — only how it is dressed —
             and the wording now matches the match overlay and its live
             region exactly, so every surface says one thing. */
          <div
            data-testid="match-result"
            className={cn(
              "mt-3 rounded-xl border px-4 py-2 text-center",
              winnerId
                ? "border-emerald-400/30 bg-emerald-500/10"
                : "border-white/20 bg-white/[0.04]"
            )}
          >
            <div className="text-3xl" aria-hidden="true">
              {winnerId ? "🏆" : "💥"}
            </div>
            <p
              className={cn(
                "mt-1 text-lg font-black",
                winnerId ? "text-emerald-300" : "text-white/80"
              )}
            >
              {winnerId
                ? `${
                    roster.find((entry) => entry.playerId === winnerId)
                      ?.displayName ?? seatLabel(winnerId)
                  } wins!`
                : "Draw — no survivor, every pawn left the arena."}
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-1.5">
          {/* PUBLIC rooms (Task 28): no player starts the match. The
              server arms a countdown as soon as two players are seated
              and starts the match itself when it expires, so the whole
              waiting area is the countdown (or, below two players, the
              existing "waiting for someone to join" copy). */}
          {isPublic && roomState === "waiting" && (
            <>
              {autoStartDeadline != null ? (
                <AutoStartCountdown deadline={autoStartDeadline} />
              ) : (
                <>
                  <p
                    data-testid="waiting-for-players"
                    className="text-center text-xs leading-tight text-white/50"
                  >
                    Waiting for another player to join
                    <span className="sr-only">…</span>
                    <AnimatedEllipsis />
                  </p>
                  <p
                    data-testid="public-waiting-hint"
                    className="text-center text-xs leading-tight text-white/40"
                  >
                    You will be matched with the next player who picks Quick
                    Play.
                  </p>
                </>
              )}
            </>
          )}

          {!isPublic && isHost && roomState === "waiting" && (
            <>
              <button
                type="button"
                onClick={onStart}
                disabled={
                  startPending || connected === false || !enoughPlayers
                }
                data-testid="start-match"
                className={cn(
                  "rounded-xl px-7 py-2.5 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
                  "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
                  "hover:from-amber-300 hover:to-orange-500 active:scale-95",
                  "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
                  FOCUS_RING
                )}
              >
                {startPending ? "Starting…" : "Start Match"}
              </button>
              {/* No "waiting for another player" line here (Task 29):
                  in a PRIVATE room the host already sees the seat list
                  and the disabled Start button, so the sentence only
                  restated what the UI showed. Public rooms keep theirs
                  — there the wait is the whole story until matchmaking
                  or Task 28's countdown resolves it. */}
            </>
          )}

          {!isPublic && !isHost && roomState === "waiting" && (
            <p
              data-testid="waiting-for-host"
              className="py-0.5 text-center text-xs leading-tight text-white/50"
            >
              Waiting for the host to start the match
              <span className="sr-only">…</span>
              <AnimatedEllipsis />
            </p>
          )}

          {/* Task 27: the leave action is no longer a text button in the
              panel footer — it is the red exit icon pinned to the screen's
              top-left corner (see <LeaveRoomButton/>, rendered by Lobby
              outside this panel). Same onLeave callback, same seat
              release; only its presentation and position changed. */}
        </div>
      </div>
    </div>
  );
}
