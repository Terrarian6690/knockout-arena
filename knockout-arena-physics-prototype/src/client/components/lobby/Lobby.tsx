import { useEffect, useState, type ReactNode } from "react";
import { useNetworkClient, useNetworkState } from "../../network/react";
import { normalizeRoomCode } from "../../network/roomCode";
import type { ConnectionStatus } from "../../network/types";
import { cn } from "../../utils/cn";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { ErrorBanner } from "./ErrorBanner";
import { RoomPanel } from "./RoomPanel";
import { MultiplayerGame } from "../game/MultiplayerGame";

/**
 * The multiplayer lobby — the UI over the network client, and the router
 * for the whole multiplayer experience: home screen → room → live match.
 *
 * When the server moves the room into "playing"/"finished", the lobby
 * hands the whole screen to <MultiplayerGame/> (authoritative snapshot
 * rendering + intent sending only). The hand-back rules: the player
 * leaves (view-level navigation, protocol v1 has no leave ack), or a
 * reconnect completed as a fresh session with no seat (the match view
 * must not pretend the seat survived). A drop MID-MATCH keeps the game
 * screen mounted: the last snapshot stays visible and MultiplayerGame
 * offers the reconnect affordance.
 *
 * Authority rules these screens live by:
 *   - every room fact (room code, your seat, host, roster, room state,
 *     winner) is displayed exactly as the server reported it — never
 *     inferred;
 *   - the Start Match button is shown only when the server-reported host id
 *     equals this client's server-assigned seat id; the server still
 *     authorizes the start itself and an `unauthorized` rejection is shown
 *     as a normal error, never bypassed;
 *   - Leave Room only calls the network client's leaveRoom() and returns to
 *     the home screen — it never touches room state itself.
 *
 * Local, purely visual state (allowed): the join input, the "Starting…"
 * pending flag on the host's button, the dismissed-error flag and the
 * leave navigation (protocol v1 sends no leave acknowledgment to the
 * leaver, so returning home is a view-level decision; the server remains
 * the authority on the room itself and any later server message wins).
 */
export function Lobby({ onPracticeSolo }: { onPracticeSolo: () => void }) {
  const client = useNetworkClient();
  const state = useNetworkState();

  const [joinCode, setJoinCode] = useState("");
  /** Local, purely visual: the join input's shape validation error. */
  const [joinError, setJoinError] = useState<string | null>(null);
  const [leftRoom, setLeftRoom] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [dismissedError, setDismissedError] = useState(false);
  const [matchActive, setMatchActive] = useState(false);

  // The server re-asserts room truth with every roster push (welcome /
  // room_state) — a fresh roster means we are seated again, so any stale
  // leave navigation is forgotten.
  useEffect(() => {
    setLeftRoom(false);
  }, [state.roster]);

  // "Starting" ends when the server moves the room on…
  useEffect(() => {
    if (state.roomState !== "waiting") setStartPending(false);
  }, [state.roomState]);
  // …or when the server answers with an error. A new error also re-opens
  // a previously dismissed banner.
  useEffect(() => {
    setStartPending(false);
    setDismissedError(false);
  }, [state.lastError]);

  const inRoom = state.roomId !== null && !leftRoom;

  // The server moved the room into the match → the game screen takes over.
  useEffect(() => {
    if (
      inRoom &&
      (state.roomState === "playing" || state.roomState === "finished")
    ) {
      setMatchActive(true);
    }
  }, [inRoom, state.roomState]);

  // Once we are connected again but no longer seated, the match view is
  // over. With seat recovery the room picture SURVIVES a drop (the server
  // reserves the seat), so a recovered connection keeps its match screen;
  // this hand-back only fires when the seat is really gone (rejected or
  // expired credential — the client clears the room state itself).
  useEffect(() => {
    if (matchActive && state.status === "connected" && !inRoom) {
      setMatchActive(false);
    }
  }, [matchActive, state.status, inRoom]);

  const handleCreate = () => {
    client.createRoom();
  };

  const handleJoinCodeChange = (value: string) => {
    // Uppercased as the player types (codes are uppercase); whitespace and
    // shape are normalized at submit time, so pasting "k7 p4" still works.
    setJoinCode(value.toUpperCase());
    setJoinError(null);
  };

  const handleJoin = () => {
    const code = normalizeRoomCode(joinCode);
    if (code === null) {
      setJoinError(
        "Room codes are 4 characters: letters and digits, but not I, O, 0 or 1."
      );
      return;
    }
    setJoinError(null);
    client.joinRoom(code);
  };

  const handleLeave = () => {
    // Fire-and-forget on protocol v1 (the server does not acknowledge the
    // leave to the leaver): navigate home once the send succeeded; the
    // server stays authoritative over the room either way.
    if (client.leaveRoom()) {
      setLeftRoom(true);
      setMatchActive(false);
    }
  };

  const handleStart = () => {
    // The server authorizes the start; the pending flag is only button
    // feedback while we wait for its answer.
    if (client.startMatch()) setStartPending(true);
  };

  const handleReconnect = () => {
    client.connect();
  };

  // The live match takes over the whole screen (also while the room is
  // "finished", so the result overlay is shown in context).
  if (matchActive) {
    return <MultiplayerGame onLeave={handleLeave} />;
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0e14] font-sans text-white antialiased">
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-lg font-black text-white shadow-lg shadow-orange-900/40">
            KA
          </div>
          <div className="leading-tight">
            <h1 className="text-lg font-bold tracking-tight text-white">
              Knockout Arena
            </h1>
            <p className="text-[11px] text-white/40">Multiplayer lobby</p>
          </div>
        </div>
        <ConnectionStatusBadge status={state.status} />
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-6">
        {inRoom ? (
          <div className="w-full max-w-md">
            {state.lastError !== null && !dismissedError && (
              <ErrorBanner
                error={state.lastError}
                onDismiss={() => setDismissedError(true)}
              />
            )}
            <RoomPanel
              roomCode={state.roomId as string}
              playerId={state.playerId as string}
              hostPlayerId={state.hostPlayerId}
              roomState={state.roomState ?? "waiting"}
              roster={state.roster}
              winnerId={state.winnerId}
              startPending={startPending}
              connected={state.status === "connected"}
              onStart={handleStart}
              onLeave={handleLeave}
            />
            {/* The seat is server-reserved while the client reconnects —
                the room stays, the hint says what is happening. */}
            <ConnectionHint
              status={state.status}
              reconnectAttempt={state.reconnectAttempt}
              onReconnect={handleReconnect}
            />
          </div>
        ) : (
          <HomeView
            status={state.status}
            reconnectAttempt={state.reconnectAttempt}
            joinCode={joinCode}
            joinError={joinError}
            onJoinCodeChange={handleJoinCodeChange}
            onCreate={handleCreate}
            onJoin={handleJoin}
            onReconnect={handleReconnect}
            onPracticeSolo={onPracticeSolo}
            error={
              state.lastError !== null && !dismissedError
                ? state.lastError
                : null
            }
            onDismissError={() => setDismissedError(true)}
          />
        )}
      </main>
    </div>
  );
}

// ── the initial screen ───────────────────────────────────────────────────

interface HomeViewProps {
  readonly status: ConnectionStatus;
  readonly reconnectAttempt: number;
  readonly joinCode: string;
  /** Local shape-validation error, or null. */
  readonly joinError: string | null;
  onJoinCodeChange: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onReconnect: () => void;
  onPracticeSolo: () => void;
  readonly error: { readonly code: string; readonly message: string } | null;
  onDismissError: () => void;
}

function HomeView({
  status,
  reconnectAttempt,
  joinCode,
  joinError,
  onJoinCodeChange,
  onCreate,
  onJoin,
  onReconnect,
  onPracticeSolo,
  error,
  onDismissError,
}: HomeViewProps) {
  const connected = status === "connected";
  const joinDisabled = !connected || joinCode.trim().length === 0;

  return (
    <div className="w-full max-w-md">
      {error !== null && (
        <ErrorBanner error={error} onDismiss={onDismissError} />
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 sm:p-8">
        <h2 className="text-center text-xl font-black tracking-tight text-white">
          Enter the arena
        </h2>
        <p className="mt-1 text-center text-sm text-white/40">
          Create a room and share its code, or join your friends.
        </p>

        <button
          type="button"
          onClick={onCreate}
          disabled={!connected}
          className={cn(
            "mt-6 w-full rounded-xl px-7 py-3 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
            "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
            "hover:from-amber-300 hover:to-orange-500 active:scale-95",
            "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          )}
        >
          Create Room
        </button>

        <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-widest text-white/25">
          <span className="h-px flex-1 bg-white/10" />
          or
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <label
          htmlFor="room-code-input"
          className="text-[11px] uppercase tracking-widest text-white/40"
        >
          Room code
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="room-code-input"
            data-testid="room-code-input"
            value={joinCode}
            onChange={(event) => onJoinCodeChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onJoin();
            }}
            placeholder="e.g. K7P4"
            disabled={!connected}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3 font-mono text-sm uppercase text-white outline-none transition-colors placeholder:text-white/25 focus:border-amber-400/50 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <button
            type="button"
            onClick={onJoin}
            disabled={joinDisabled}
            className={cn(
              "rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white/80 transition-colors",
              "hover:bg-white/10 active:scale-95",
              "disabled:cursor-not-allowed disabled:opacity-40"
            )}
          >
            Join Room
          </button>
        </div>
        {joinError !== null && (
          <p
            data-testid="join-error"
            className="mt-2 text-xs text-red-300"
          >
            {joinError}
          </p>
        )}

        <ConnectionHint
          status={status}
          reconnectAttempt={reconnectAttempt}
          onReconnect={onReconnect}
        />
      </div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={onPracticeSolo}
          className="text-xs font-semibold text-white/40 underline-offset-4 transition-colors hover:text-white/70 hover:underline"
        >
          Practice solo (local engine)
        </button>
      </div>
    </div>
  );
}

/**
 * Contextual connection feedback under the join row. This is display of
 * the CLIENT's connection status only — room facts never appear here.
 */
function ConnectionHint({
  status,
  reconnectAttempt,
  onReconnect,
}: {
  readonly status: ConnectionStatus;
  readonly reconnectAttempt: number;
  onReconnect: () => void;
}) {
  if (status === "connected") return null;

  if (status === "connecting") {
    return <HintText>Connecting to the server…</HintText>;
  }
  if (status === "reconnecting") {
    return (
      <HintText>
        Connection lost — retrying
        {reconnectAttempt > 0 ? ` (attempt ${reconnectAttempt})` : ""}…
      </HintText>
    );
  }
  if (status === "closed") {
    return <HintText>The connection was closed. Reload the page.</HintText>;
  }

  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      <HintText>Not connected.</HintText>
      <button
        type="button"
        onClick={onReconnect}
        className="rounded-xl border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 active:scale-95"
      >
        Reconnect
      </button>
    </div>
  );
}

function HintText({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 text-center text-xs text-white/35">{children}</p>
  );
}
