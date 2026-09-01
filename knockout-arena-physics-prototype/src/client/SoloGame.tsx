import { useGame } from "./useGame";
import { Header } from "./components/Header";
import { ArenaGame } from "./components/ArenaGame";
import { ControlPanel } from "./components/ControlPanel";
import { EliminationOverlay } from "./components/EliminationOverlay";

/**
 * The single-player prototype (the app's original screen), unchanged: one
 * local engine instance playing the "p0" seat. Kept as the "practice solo"
 * mode of the lobby era — the layout and behavior are exactly what App.tsx
 * rendered before the lobby existed, with a discreet way back to the lobby
 * added.
 */
export function SoloGame({ onExit }: { onExit: () => void }) {
  const { snapshot, dispatch, canvasRef, canvasSize } = useGame();

  if (!snapshot) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0e14] text-white/50">
        Loading…
      </div>
    );
  }

  const finished = snapshot.phase === "finished";
  const winner = finished
    ? snapshot.pawns.find((p) => p.id === snapshot.winnerId) ?? null
    : null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0e14] font-sans text-white antialiased">
      <Header phase={snapshot.phase} winnerName={winner?.name ?? null} />

      <main className="relative flex min-h-0 flex-1">
        <ArenaGame
          snapshot={snapshot}
          dispatch={dispatch}
          canvasRef={canvasRef}
          canvasSize={canvasSize}
        />

        <button
          type="button"
          onClick={onExit}
          className="absolute bottom-4 left-4 z-10 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-xs font-semibold text-white/70 backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
        >
          ← Lobby
        </button>

        {finished && (
          <EliminationOverlay
            won={snapshot.winnerId === snapshot.localPawnId}
            onReset={() => dispatch({ type: "reset" })}
          />
        )}
      </main>

      <ControlPanel
        phase={snapshot.phase}
        power={snapshot.power}
        onPowerChange={(power) => dispatch({ type: "setPower", power })}
        onLaunch={() => dispatch({ type: "confirmLaunch" })}
        onReset={() => dispatch({ type: "reset" })}
      />
    </div>
  );
}
