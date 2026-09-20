import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeDisplayName,
} from "../../network/displayName";
import { useNetworkClient, useNetworkState } from "../../network/react";
import { normalizeRoomCode } from "../../network/roomCode";
import type { ConnectionStatus } from "../../network/types";
import { cn } from "../../utils/cn";
import { BrandLogo } from "../BrandLogo";
import { ErrorBanner } from "./ErrorBanner";
import { getPrefillJoinCode } from "./invite";
import { LeaveRoomButton } from "./LeaveRoomButton";
import {
  loadSkinPreference,
  saveSkinPreference,
  type SkinChoice,
} from "./skins";
import { SkinPicker } from "./SkinPicker";
import { RoomPanel } from "./RoomPanel";
import { MultiplayerGame } from "../game/MultiplayerGame";

/**
 * The multiplayer lobby — the UI over the network client, and the router
 * for the whole multiplayer experience: home screen → room → live match.
 *
 * When the server moves the room into "playing"/"finished", the lobby
 * hands the whole screen to <MultiplayerGame/> (authoritative snapshot
 * rendering + intent sending only). The hand-back rules: the player
 * leaves (view-level navigation, protocol v1 has no leave ack); a
 * reconnect completed as a fresh session with no seat (the match view
 * must not pretend the seat survived); or the server returns the room
 * to "waiting" while we are still seated — the Task 25 rematch, where
 * the players stay in their room and this same lobby comes back for the
 * next match. A drop MID-MATCH keeps the game screen mounted: the last
 * snapshot stays visible and MultiplayerGame offers the reconnect
 * affordance.
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

  // Opening an invite link (?room=CODE) prefills the Join input — nothing
  // more: the player still presses Join Room themselves (never auto-join),
  // and an absent/invalid param degrades to an empty input.
  const [joinCode, setJoinCode] = useState<string>(() => getPrefillJoinCode());
  /** Local, purely visual: the join input's shape validation error. */
  const [joinError, setJoinError] = useState<string | null>(null);
  /**
   * The player's chosen display name. Required before entering any room
   * (see `nameReady` below). It is kept here, above both screens, so the
   * home screen's name box and the room's rename box are one value.
   */
  const [playerName, setPlayerName] = useState("");
  /** Local, purely visual: why the name was refused, if it was. */
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
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

  // ── the name gate ──────────────────────────────────────────────────
  // A player must name themselves before entering a room. The rule is
  // the SERVER's own display-name rule (normalizeDisplayName, shared with
  // src/server/displayName.ts) — the gate reuses it rather than inventing
  // a second definition of "valid name".
  const validName = normalizeDisplayName(playerName);
  const nameReady = validName !== null;

  /**
   * Guard every room entry point. Returns the valid name, or null after
   * explaining the refusal and sending focus to the name box — so the
   * block is never a dead click.
   */
  const requireName = (): string | null => {
    if (validName !== null) return validName;
    setNameError(
      playerName.trim().length === 0
        ? "Choose a name before you play."
        : `Names are 1\u2013${MAX_DISPLAY_NAME_LENGTH} characters — letters, digits, punctuation; no line breaks.`
    );
    nameInputRef.current?.focus();
    return null;
  };

  // Name the seat as soon as the server gives us one. The server only
  // accepts set_name from a SEATED session, so the chosen name is applied
  // on arrival rather than sent with the join — no protocol change, no
  // matchmaking change.
  //
  // The ref keeps this to ONE send per name per seat. It records the seat
  // it applied to, not just the name: leaving and re-entering can land
  // the player back in the same room id with the same player id, and that
  // genuinely new seat still needs naming.
  const appliedName = useRef<{ seat: string; name: string } | null>(null);
  useEffect(() => {
    if (state.roomId === null || state.playerId === null) {
      appliedName.current = null; // a new seat must be named again
      return;
    }
    const seat = `${state.roomId}:${state.playerId}`;
    const applied = appliedName.current;
    if (validName === null) return;
    if (applied !== null && applied.seat === seat && applied.name === validName) {
      return;
    }
    if (client.setName(validName)) appliedName.current = { seat, name: validName };
  }, [client, state.roomId, state.playerId, validName]);

  // ── the disc skin ──────────────────────────────────────────────────
  // The cosmetic look of this player's pawn, chosen in the main menu
  // (right of the name box), persisted locally, and applied to the seat
  // exactly like the name is: the server only accepts set_skin from a
  // SEATED session, so the choice rides down on the first roster after
  // joining. One send per skin per seat (the same ref discipline as the
  // name gate), so re-renders never spam the wire.
  //
  // `null` = the RANDOM default: nothing is stored and NOTHING is sent
  // on a fresh seat — the server deals a random skin (excluding what
  // the seated players wear) at seating time, so only after joining is
  // the skin known. An explicit choice is sent like before, and picking
  // "Random" while seated sends null to get a fresh draw.
  const [skin, setSkinState] = useState<SkinChoice>(() => loadSkinPreference());
  const onSkinChange = (next: SkinChoice) => {
    setSkinState(next);
    saveSkinPreference(next);
  };
  const appliedSkin = useRef<{ seat: string; skin: SkinChoice } | null>(null);
  useEffect(() => {
    if (state.roomId === null || state.playerId === null) {
      appliedSkin.current = null; // a new seat must be skinned again
      return;
    }
    const seat = `${state.roomId}:${state.playerId}`;
    const applied = appliedSkin.current;
    if (applied !== null && applied.seat === seat && applied.skin === skin) {
      return;
    }
    if (skin === null) {
      // No explicit preference → NOTHING to apply: the server dealt the
      // random skin while seating us, and the picker (a home-screen
      // control) cannot change it mid-room. Just record the seat.
      appliedSkin.current = { seat, skin: null };
      return;
    }
    if (client.setSkin(skin)) appliedSkin.current = { seat, skin };
  }, [client, state.roomId, state.playerId, skin]);

  // A match that is already running when we seat down may not include
  // us: a late joiner waits in the lobby for the NEXT match. The
  // snapshot's pawn list is the authority — our pawn simply is not in
  // the frozen roster. (No snapshot yet counts as "not in it"; a real
  // participant's pawn shows up within a frame.)
  const inLiveMatch =
    state.snapshot !== null &&
    state.playerId !== null &&
    state.snapshot.pawns.some((p) => p.id === state.playerId);
  const waitingForMatch =
    inRoom && state.roomState === "playing" && !inLiveMatch;

  // The server moved the room into a match WE ARE PART of → the game
  // screen takes over (also while "finished", so the result overlay is
  // shown in context). A waiting late joiner stays in the lobby.
  useEffect(() => {
    if (
      inRoom &&
      (state.roomState === "playing" || state.roomState === "finished") &&
      inLiveMatch
    ) {
      setMatchActive(true);
    }
  }, [inRoom, state.roomState, inLiveMatch]);

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

  // The rematch hand-back (Task 25). The server put the room back into
  // "waiting" — after a finished match, because someone chose Play
  // again. We are STILL SEATED, so this is not a leave: the match screen
  // gives way to the very same pre-match lobby the room started in, and
  // the host's existing Start Match button runs the next match. Driven
  // by server-reported room state like every other room fact here, so
  // every player in the room returns together, whoever pressed it.
  useEffect(() => {
    if (matchActive && inRoom && state.roomState === "waiting") {
      setMatchActive(false);
    }
  }, [matchActive, inRoom, state.roomState]);

  const handleCreate = () => {
    if (requireName() === null) return;
    client.createRoom();
  };

  const handleJoinCodeChange = (value: string) => {
    // Uppercased as the player types (codes are uppercase); whitespace and
    // shape are normalized at submit time, so pasting "k7 p4" still works.
    setJoinCode(value.toUpperCase());
    setJoinError(null);
  };

  const handleJoinPublic = () => {
    // Matchmaking needs no room input, but it still needs a named player.
    if (requireName() === null) return;
    // Any stale code-entry error is cleared so it cannot look like a
    // result of this action.
    setJoinError(null);
    client.joinPublicRoom();
  };

  const handleJoin = () => {
    if (requireName() === null) return;
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

  const handlePlayAgain = () => {
    // Stay in the room: ask the server to reopen it. The view is NOT
    // switched here — the room state push that follows does it (above),
    // so the lobby only ever reflects what the server actually did. A
    // refusal surfaces as a normal error banner, like any other action.
    client.returnToLobby();
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
    return (
      <MultiplayerGame onLeave={handleLeave} onPlayAgain={handlePlayAgain} />
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0e14] font-sans text-white antialiased">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="leading-tight">
            {/* Decorative logo inside the heading: one announcement. */}
            <h1 className="flex items-center">
              <BrandLogo height={36} decorative />
              <span className="sr-only">Knockout Arena</span>
            </h1>
          </div>
        </div>
        {/* The connection-status badge that used to sit here was removed
            on request: the lobby stays clean, and connection problems
            still surface through the error banner and the reconnect
            affordance instead of an always-on indicator. */}
      </header>

      {/* The room view top-aligns (the home screen stays centered): with
          the taller room card a centered layout could push the room code
          above the fold, forcing a scroll right after creating/joining. */}
      <main
        className={cn(
          "relative flex min-h-0 flex-1 justify-center overflow-y-auto px-4",
          inRoom ? "items-start py-2" : "items-center py-3"
        )}
      >
        {/* Task 27: the way out lives in the screen's top-left corner —
            outside the room panel, in the margin between the panel and
            the screen edge — rather than as a text button buried in the
            panel footer. Absolutely positioned, so it never competes
            with the panel for vertical space. */}
        {inRoom && (
          <LeaveRoomButton
            onLeave={handleLeave}
            className="absolute left-2 top-2 z-20 sm:left-4 sm:top-3"
          />
        )}
        {inRoom ? (
          <div className="w-full max-w-2xl">
            {state.lastError !== null && !dismissedError && (
              <ErrorBanner
                error={state.lastError}
                onDismiss={() => setDismissedError(true)}
              />
            )}
            {waitingForMatch && (
              <div
                data-testid="match-waiting-banner"
                role="status"
                className="mb-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2.5"
              >
                <p className="text-sm font-bold text-amber-200">
                  Waiting for the current game to end…
                </p>
                <p className="text-xs text-white/60">
                  The running match has a fixed roster — you will join the
                  next one automatically.
                </p>
              </div>
            )}
            <RoomPanel
              roomCode={state.roomId as string}
              playerId={state.playerId as string}
              hostPlayerId={state.hostPlayerId}
              autoStartDeadline={state.autoStartDeadline}
              roomState={state.roomState ?? "waiting"}
              roomVisibility={state.roomVisibility}
              roster={state.roster}
              winnerId={state.winnerId}
              startPending={startPending}
              connected={state.status === "connected"}
              onStart={handleStart}
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
            playerName={playerName}
            nameError={nameError}
            nameReady={nameReady}
            nameInputRef={nameInputRef}
            onPlayerNameChange={(value) => {
              setPlayerName(value);
              setNameError(null);
            }}
            skin={skin}
            onSkinChange={onSkinChange}
            onJoinCodeChange={handleJoinCodeChange}
            onCreate={handleCreate}
            onJoin={handleJoin}
            onJoinPublic={handleJoinPublic}
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
  /** The player's chosen name (required before any room entry). */
  readonly playerName: string;
  /** Why the name was refused, or null. */
  readonly nameError: string | null;
  /** Whether the current name passes the shared display-name rule. */
  readonly nameReady: boolean;
  readonly nameInputRef: React.RefObject<HTMLInputElement | null>;
  onPlayerNameChange: (value: string) => void;
  /**
   * The currently chosen disc skin, or null = the RANDOM default (the
   * server deals one at seating; unknown until the player joins).
   */
  readonly skin: SkinChoice;
  onSkinChange: (skin: SkinChoice) => void;
  onJoinCodeChange: (value: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onJoinPublic: () => void;
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
  playerName,
  nameError,
  nameReady,
  nameInputRef,
  onPlayerNameChange,
  skin,
  onSkinChange,
  onJoinCodeChange,
  onCreate,
  onJoin,
  onJoinPublic,
  onReconnect,
  onPracticeSolo,
  error,
  onDismissError,
}: HomeViewProps) {
  const connected = status === "connected";
  const joinDisabled = !connected || joinCode.trim().length === 0;
  /**
   * Whether what has been typed is a COMPLETE, well-formed room code —
   * the same check the join handler runs (normalizeRoomCode), so the
   * button turns green exactly when pressing it would actually work.
   */
  const codeReady = connected && normalizeRoomCode(joinCode) !== null;
  // The gate is advisory in the UI and enforced in the handlers: the
  // buttons stay ENABLED without a name so clicking one explains the
  // requirement (a disabled button with no reason is a dead end).
  const needsName = !nameReady;

  return (
    <div className="w-full max-w-md">
      {error !== null && (
        <ErrorBanner error={error} onDismiss={onDismissError} />
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
        <h2 className="text-center text-xl font-black tracking-tight text-white">
          Enter the arena
        </h2>
        <p className="mt-0.5 text-center text-sm text-white/50">
          Jump into a public game, or play privately with friends.
        </p>

        {/* The name comes FIRST: every way into a room needs one, so it
            is asked for before any of them are offered. The buttons stay
            clickable without it and explain the requirement on use. */}
        <div className="mt-3">
          {/* Task 31: the label sits BESIDE the field, not above it. It
              was already a real <label htmlFor>, so this is a layout
              change — the input keeps exactly one accessible name and
              gains no competing aria-label. */}
          <div className="flex items-center gap-2">
            <label
              htmlFor="player-name-input"
              className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-widest text-white/50"
            >
              {/* The "(required)" tag is NOT shown up front: an empty
                  box on arrival is the normal state, not a mistake. It
                  appears only once the player has actually tried to
                  enter a game without a name — the same signal that
                  raises nameError — so it reads as an answer to what
                  they just did. Colour is the design system's danger red
                  (red-300), as the error banner and leave control use. */}
              Player name:{" "}
              {nameError !== null && (
                <span data-testid="name-required-tag" className="text-red-300">
                  (required)
                </span>
              )}
            </label>
            <input
              id="player-name-input"
              data-testid="player-name-input"
              ref={nameInputRef}
              value={playerName}
              onChange={(event) => onPlayerNameChange(event.target.value)}
              placeholder="e.g. Ada"
              // Bounds the UTF-16 units at 2× the code-point maximum, so
              // every valid name (including surrogate pairs) still fits.
              maxLength={2 * MAX_DISPLAY_NAME_LENGTH}
              autoComplete="nickname"
              spellCheck={false}
              required
              aria-required="true"
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? "player-name-error" : undefined}
              className={cn(
                "min-w-0 flex-1 rounded-xl border bg-white/5 px-4 py-2 text-sm text-white outline-none transition-colors",
                "placeholder:text-white/50 focus:border-amber-400/50",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                nameError !== null ? "border-red-400/50" : "border-white/15"
              )}
            />
            {/* The disc-skin picker lives RIGHT OF the name box (the
                input is flex-1, so the picker takes exactly its own
                width). The button itself previews the chosen skin. */}
            <SkinPicker value={skin} onChange={onSkinChange} />
          </div>
          {nameError !== null && (
            <p
              id="player-name-error"
              data-testid="name-required-error"
              role="alert"
              className="mt-1 text-xs text-red-300"
            >
              {nameError}
            </p>
          )}
        </div>

        {/* Matchmaking (Task 17). One click, no code: the server finds an
            open public game or opens a new one. Deliberately NOT a room
            browser — there is nothing to choose between. */}
        <button
          type="button"
          onClick={onJoinPublic}
          disabled={!connected}
          data-testid="join-public"
          aria-describedby={needsName ? "name-gate-hint" : undefined}
          className={cn(
            "mt-3 w-full rounded-xl px-7 py-2.5 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
            "bg-gradient-to-br from-sky-400 to-indigo-600 text-white",
            "hover:from-sky-300 hover:to-indigo-500 active:scale-95",
            "shadow-indigo-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          )}
        >
          Quick Play
        </button>
        <p className="mt-1 text-center text-xs text-white/40">
          Play against anyone online — no room code needed.
        </p>
        {needsName && (
          <p
            id="name-gate-hint"
            data-testid="name-gate-hint"
            className="mt-1 text-center text-xs text-red-300/90"
          >
            Enter a name above to play.
          </p>
        )}

        <div className="my-2 flex items-center gap-3 text-[11px] uppercase tracking-widest text-white/50">
          <span className="h-px flex-1 bg-white/10" />
          or play with friends
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <button
          type="button"
          onClick={onCreate}
          disabled={!connected}
          aria-describedby={needsName ? "name-gate-hint" : undefined}
          className={cn(
            "w-full rounded-xl px-7 py-2.5 text-base font-bold uppercase tracking-wide shadow-lg transition-all",
            "bg-gradient-to-br from-amber-400 to-orange-600 text-white",
            "hover:from-amber-300 hover:to-orange-500 active:scale-95",
            "shadow-orange-900/40 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          )}
        >
          Create Room
        </button>

        <div className="my-2 flex items-center gap-3 text-[11px] uppercase tracking-widest text-white/50">
          <span className="h-px flex-1 bg-white/10" />
          or
          <span className="h-px flex-1 bg-white/10" />
        </div>


        <label
          htmlFor="room-code-input"
          className="text-[11px] uppercase tracking-widest text-white/50"
        >
          Room code
        </label>
        <div className="mt-1 flex gap-2">
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
            className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2 font-mono text-sm uppercase text-white outline-none transition-colors placeholder:text-white/50 focus:border-amber-400/50 disabled:cursor-not-allowed disabled:opacity-40"
          />
          <button
            type="button"
            onClick={onJoin}
            disabled={joinDisabled}
            data-testid="join-room"
            data-code-ready={codeReady ? "true" : "false"}
            className={cn(
              "rounded-xl border px-5 py-2 text-sm font-semibold transition-colors",
              "active:scale-95",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
              // Green the moment a full, valid code is in the box: the
              // button is telling you it will work.
              codeReady
                ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
                : "border-white/15 bg-white/5 text-white/80 hover:bg-white/10"
            )}
          >
            Join Room
          </button>
        </div>
        {joinError !== null && (
          <p
            data-testid="join-error"
            role="alert"
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

      <div className="mt-2 text-center">
        <button
          type="button"
          onClick={onPracticeSolo}
          className="rounded-sm text-xs font-semibold text-white/50 underline-offset-4 transition-colors hover:text-white/70 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
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
        className="rounded-xl border border-white/15 bg-white/5 px-5 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        Reconnect
      </button>
    </div>
  );
}

function HintText({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 text-center text-xs text-white/50">{children}</p>
  );
}
