import { useEffect, useRef } from "react";
import { computeTransform, render } from "../renderer";
import { createArena, type PlayerIntent, type GameStateSnapshot } from "../../game";

/**
 * Canvas view for the arena. Receives the authoritative game state from App
 * (single instance — see App.tsx), draws it, and translates canvas-relative
 * pointer coordinates into world coordinates for aiming.
 */
interface ArenaGameProps {
  /** Snapshot of the shared game instance. */
  snapshot: GameStateSnapshot;
  /** Dispatches input intents to the shared game instance. */
  dispatch: (intent: PlayerIntent) => void;
  /** Ref of the canvas element (owned by the shared useGame hook). */
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** Measured canvas CSS size (owned by the shared useGame hook). */
  canvasSize: { width: number; height: number };
}

export function ArenaGame({
  snapshot,
  dispatch,
  canvasRef,
  canvasSize,
}: ArenaGameProps) {
  const arenaRef = useRef(createArena());

  // Render whenever the snapshot or canvas size changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snapshot) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvasSize.width;
    const h = canvasSize.height;
    if (w === 0 || h === 0) return;

    // Set backing store at device pixel ratio for crisp rendering.
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const transform = computeTransform(w, h);
    render(ctx, snapshot, arenaRef.current, transform);
  }, [snapshot, canvasSize, canvasRef]);

  function worldPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const transform = computeTransform(canvasSize.width, canvasSize.height);
    if (transform.scale <= 0) {
      // Canvas not measured yet — fall back to the world center.
      return { x: arenaRef.current.centerX, y: arenaRef.current.centerY };
    }
    return {
      x: (px - transform.offsetX) / transform.scale,
      y: (py - transform.offsetY) / transform.scale,
    };
  }

  function handlePointer(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = worldPoint(e);
    const intent: PlayerIntent = { type: "aim", x: p.x, y: p.y };
    dispatch(intent);
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-crosshair touch-none"
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
      />
    </div>
  );
}
