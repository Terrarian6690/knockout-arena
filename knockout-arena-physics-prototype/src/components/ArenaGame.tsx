import { useEffect, useRef } from "react";
import { useGame } from "../game/useGame";
import { computeTransform, render } from "../game/renderer";
import { createArena } from "../game/arena";
import type { GameAction } from "../game/types";

/**
 * Canvas view for the arena. Owns the game loop's rendering and translates
 * canvas-relative mouse coordinates into world coordinates for aiming.
 */
export function ArenaGame() {
  const { snapshot, dispatch, canvasRef, canvasSize } = useGame();
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
    return {
      x: (px - transform.offsetX) / transform.scale,
      y: (py - transform.offsetY) / transform.scale,
    };
  }

  function handlePointer(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = worldPoint(e);
    const action: GameAction = { type: "aim", x: p.x, y: p.y };
    dispatch(action);
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
