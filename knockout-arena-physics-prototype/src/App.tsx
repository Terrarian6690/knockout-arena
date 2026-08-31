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
 * The engine lifecycle is handled entirely by useGame(); this component is
 * purely presentational.
 */
export default function App() {
  const { snapshot, dispatch } = useGame();

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
        <ArenaGame />

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
