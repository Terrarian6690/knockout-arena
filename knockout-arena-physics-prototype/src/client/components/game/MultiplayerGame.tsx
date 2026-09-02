import { useEffect, useRef, useState } from "react";
import { useNetworkClient, useNetworkState } from "../../network/react";
import type { GameStateSnapshot } from "../../../game";
import { cn } from "../../utils/cn";
import { ConnectionStatusBadge } from "../lobby/ConnectionStatusBadge";
import { ErrorBanner } from "../lobby/ErrorBanner";
import { ArenaView } from "./ArenaView";
import { MatchControls } from "./MatchControls";
import { MatchRail } from "./MatchRail";
import { MatchResultOverlay } from "./MatchResultOverlay";
import { canLocalPlayerAct } from "./localControl";

/**
 * The multiplayer game screen — the browser's side of an authoritative
 * match. It does exactly three things:
 *
 *   1. RENDER the latest server snapshot (viewer-projected, so
 *      `snapshot.localPawnId` is the server's own statement of who "you"
 *      are — never computed locally);
 *   2. SEND player intents (aim / setPower / confirmLaunch) when the
 *      local player may act — the server alone decides whether they
 *      succeed;
 *   3. SHOW connection status, server errors and the server's match
 *      result.
 *
 * It never simulates: no engine tick, no physics, no round advancement, no
 * elimination or winner logic. Between server pushes the picture simply
 * stays as the server last sent it (direct snapshot rendering — no
 * interpolation in this first version).
 *
 * Rounds are SIMULTANEOUS: during the aiming phase every alive player
 * chooses independently (aim, power) and Launch locks in their OWN move
 * ("Ready"); the round resolves on the server once everyone is ready.
 * Disconnects (seat recovery): the last authoritative snapshot stays
 * visible, input is refused while not connected, and the reconnect
 * handshake restores the same seat and its current-round choice state.
 */
export function MultiplayerGame({ onLeave }: { onLeave: () => void }) {
  const client = useNetworkClient();
  const state = useNetworkState();

  // Keep the LAST authoritative snapshot visible across a disconnect:
  // the network client (honestly) clears room state on a drop; the view
  // remembering the last server frame for display does not resurrect the
  // seat — commands stay refused and the connection banner says the truth.
  const lastSnapshotRef = useRef<GameStateSnapshot | null>(null);
  if (state.snapshot !== null) lastSnapshotRef.current = state.snapshot;
  const snapshot = state.snapshot ?? lastSnapshotRef.current;

  const [dismissedError, setDismissedError] = useState(false);
  // A fresh server error re-opens a previously dismissed banner.
  useEffect(() => {
    setDismissedError(false);
  }, [state.lastError]);

  // Local, purely visual pending power: shown immediately for
  // responsiveness, replaced by the authoritative value as soon as ANY
  // fresh snapshot arrives (the server's echo).
  const [pendingPower, setPendingPower] = useState<number | null>(null);
  useEffect(() => {
    setPendingPower(null);
  }, [state.snapshot]);

  const canAct = canLocalPlayerAct(snapshot);
  const lockedIn =
    snapshot?.pawns.find((pawn) => pawn.id === snapshot.localPawnId)
      ?.confirmed ?? false;
  const connected = state.status === "connected";

  const handleAim = (point: { x: number; y: number }) => {
    client.submitCommand({ type: "aim", x: point.x, y: point.y });
  };

  const handlePowerChange = (power: number) => {
    if (client.submitCommand({ type: "setPower", power })) {
      setPendingPower(power);
    }
  };

  const handleLaunch = () => {
    client.submitCommand({ type: "confirmLaunch" });
  };

  const handleReconnect = () => {
    client.connect();
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0e14] font-sans text-white antialiased">
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-lg font-black text-white shadow-lg shadow-orange-900/40">
            KA
          </div>
          <div className="leading-tight">
            <h1 className="text-lg font-bold tracking-tight text-white">
              Knockout Arena
            </h1>
            <p className="text-[11px] text-white/40">Multiplayer match</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {snapshot !== null && <RoundBadge snapshot={snapshot} />}
          <ConnectionStatusBadge status={state.status} />
        </div>
      </header>

      {snapshot === null ? (
        <main className="flex flex-1 items-center justify-center px-4 text-sm text-white/50">
          Waiting for the match state…
        </main>
      ) : (
        <>
          <MatchRail snapshot={snapshot} hostPlayerId={state.hostPlayerId} />

          {state.lastError !== null && !dismissedError && (
            <div className="px-4 pt-3 sm:px-6">
              <ErrorBanner
                error={state.lastError}
                onDismiss={() => setDismissedError(true)}
              />
            </div>
          )}

          <main className="relative flex min-h-0 flex-1">
            <ArenaView
              snapshot={snapshot}
              interactive={canAct && connected}
              onAim={handleAim}
            />

            {!connected && (
              <ConnectionBanner
                status={state.status}
                reconnectAttempt={state.reconnectAttempt}
                onReconnect={handleReconnect}
              />
            )}

            {snapshot.phase === "finished" && (
              <MatchResultOverlay
                winnerId={snapshot.winnerId}
                localPawnId={snapshot.localPawnId}
                pawns={snapshot.pawns}
                onLeave={onLeave}
              />
            )}
          </main>

          {snapshot.phase !== "finished" && (
            <MatchControls
              power={pendingPower ?? snapshot.power}
              canAct={canAct}
              lockedIn={lockedIn}
              onPowerChange={handlePowerChange}
              onLaunch={handleLaunch}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── small internal pieces ────────────────────────────────────────────────

/**
 * The round status (simultaneous rounds — no "whose turn"). Read from the
 * snapshot: what the phase is and where the viewer's own choice stands.
 */
function RoundBadge({ snapshot }: { readonly snapshot: GameStateSnapshot }) {
  const localPawn = snapshot.pawns.find(
    (pawn) => pawn.id === snapshot.localPawnId
  );

  let label: string;
  let className: string;
  if (snapshot.phase === "finished") {
    label = "Match over";
    className = "bg-emerald-500/15 text-emerald-300 border-emerald-400/30";
  } else if (snapshot.phase === "moving") {
    label = "Round resolving…";
    className = "bg-sky-500/15 text-sky-300 border-sky-400/30";
  } else if (localPawn === undefined || localPawn.eliminated) {
    label = "You're out — watching";
    className = "bg-white/5 text-white/50 border-white/15";
  } else if (localPawn.confirmed) {
    label = "Ready — waiting for other players…";
    className = "bg-emerald-500/15 text-emerald-300 border-emerald-400/30";
  } else {
    label = "Choose your move — aim!";
    className = "bg-amber-500/15 text-amber-300 border-amber-400/30";
  }

  return (
    <span
      data-testid="turn-badge"
      className={cn(
        "hidden rounded-full border px-3 py-1 text-xs font-semibold sm:inline-block",
        className
      )}
    >
      {label}
    </span>
  );
}

/**
 * Non-blocking connection banner over the arena: the last snapshot stays
 * visible underneath; only the reconnect affordance is interactive.
 */
function ConnectionBanner({
  status,
  reconnectAttempt,
  onReconnect,
}: {
  readonly status: string;
  readonly reconnectAttempt: number;
  onReconnect: () => void;
}) {
  return (
    <div
      data-testid="connection-banner"
      className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/30 bg-slate-900/90 px-4 py-2 text-xs shadow-lg backdrop-blur">
        {status === "reconnecting" && (
          <span className="font-semibold text-amber-300">
            Connection lost — retrying
            {reconnectAttempt > 0 ? ` (attempt ${reconnectAttempt})` : ""}…
          </span>
        )}
        {status === "connecting" && (
          <span className="font-semibold text-amber-300">Connecting…</span>
        )}
        {status === "disconnected" && (
          <>
            <span className="font-semibold text-red-300">
              Disconnected from the match
            </span>
            <button
              type="button"
              onClick={onReconnect}
              className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 font-semibold text-white/80 transition-colors hover:bg-white/10"
            >
              Reconnect
            </button>
          </>
        )}
        {status === "closed" && (
          <span className="font-semibold text-white/60">
            The connection was closed. Reload the page.
          </span>
        )}
      </div>
    </div>
  );
}
