import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGame,
  withPlayerId,
  projectSnapshot,
  type GameHandle,
  type PlayerIntent,
  type GameStateSnapshot,
} from "../game";

/**
 * The local player id used by this client. Purely a CLIENT concern: the
 * engine itself has no notion of a local player. In the multiplayer phase
 * this becomes the seat assigned by the session/room handshake.
 */
const LOCAL_PLAYER_ID = "p0";

/**
 * React hook bridging the engine core to the UI.
 *
 * The engine (`GameHandle`) is framework-agnostic and lives outside React's
 * render cycle; this hook creates it, runs an animation-frame loop, and
 * projects its authoritative state into React state for rendering.
 *
 * The engine pushes RAW GameState (server-ready); this hook is where the
 * local perspective is attached, by projecting each state with the client's
 * own player id. Player intents are likewise converted into full commands
 * here — exactly where a future network layer will attach the authenticated
 * identity instead.
 *
 * IMPORTANT: the app must have exactly ONE useGame() instance (in App.tsx),
 * because each call creates an independent engine. Children receive the state
 * via props — never call this hook from a second component.
 *
 * When multiplayer arrives, this hook is the natural place to swap the local
 * authoritative loop for a networked one (e.g. latency interpolation between
 * server snapshots) without touching the engine classes.
 */
export function useGame() {
  const gameRef = useRef<GameHandle | null>(null);
  const [snapshot, setSnapshot] = useState<GameStateSnapshot | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Create the game engine + run its update loop.
  useEffect(() => {
    const game = createGame();
    gameRef.current = game;

    // Project every authoritative state update into this client's view.
    const unsubscribe = game.subscribe((state) =>
      setSnapshot(projectSnapshot(state, LOCAL_PLAYER_ID))
    );

    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      game.update(dt);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      game.destroy();
      gameRef.current = null;
    };
  }, []);

  const dispatch = useMemo(() => {
    return (intent: PlayerIntent) =>
      gameRef.current?.dispatch(withPlayerId(intent, LOCAL_PLAYER_ID));
  }, []);

  // Observe the canvas size for hi-DPI rendering. Depends on the snapshot
  // being available so this re-runs once the arena has actually mounted.
  const mounted = snapshot !== null;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted]);

  return { snapshot, dispatch, canvasRef, canvasSize };
}
