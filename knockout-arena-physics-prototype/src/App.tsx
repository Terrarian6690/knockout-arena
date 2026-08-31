import { useGame } from "./game/useGame";
import { Header } from "./components/Header";
import { ArenaGame } from "./components/ArenaGame";
import { ControlPanel } from "./components/ControlPanel";
import { EliminationOverlay } from "./components/EliminationOverlay";

/**
 * Knockout Arena — Phase 1 single-player prototype.
 *
 * Layout:
 *   Header (title + phase)
 *   ArenaGame (canvas, fills available space)
 *   ControlPanel (power selector + launch/reset)
 *
 * There is exactly ONE game instance in the whole app: it is created here by
 * useGame() and handed down to the children as props. The canvas and the
 * controls therefore always read from — and write to — the same game state.
 */
export default function App() {
  const { snapshot, dispatch, canvasRef, canvasSize } = useGame();

  if (!snapshot) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0e14] text-white/50">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0e14] font-sans text-white antialiased">
      <Header phase={snapshot.phase} />

      <main className="relative flex min-h-0 flex-1">
        <ArenaGame
          snapshot={snapshot}
          dispatch={dispatch}
          canvasRef={canvasRef}
          canvasSize={canvasSize}
        />

        {snapshot.phase === "eliminated" && (
          <EliminationOverlay onReset={() => dispatch({ type: "reset" })} />
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
