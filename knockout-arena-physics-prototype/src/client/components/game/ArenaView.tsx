import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { createArena, type GameStateSnapshot } from "../../../game";
import { computeTransform, render } from "../../renderer";
import { cn } from "../../utils/cn";

/**
 * The multiplayer arena canvas.
 *
 * Rendering only: it draws the AUTHORITATIVE snapshot through the same
 * pure renderer the single-player screen uses (the snapshot is already
 * viewer-projected by the server, so the local perspective — including
 * `localPawnId` — comes straight from the data). Pointer input is
 * translated from screen to world coordinates and handed to `onAim` —
 * an INPUT calculation, nothing more: no trajectory, no simulation, no
 * state mutation on this side of the wire.
 */
interface ArenaViewProps {
  /** The latest authoritative (viewer-projected) snapshot. */
  readonly snapshot: GameStateSnapshot;
  /** Whether pointer input should produce aim intents. */
  readonly interactive: boolean;
  /** Receives world-space aim points (input calculation only). */
  onAim: (point: { x: number; y: number }) => void;
}

export function ArenaView({ snapshot, interactive, onAim }: ArenaViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const arenaRef = useRef(createArena());
  const canvasSize = useCanvasSize(canvasRef, snapshot !== null);

  // Redraw whenever the authoritative state (or the canvas size) changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvasSize.width;
    const h = canvasSize.height;
    if (w === 0 || h === 0) return;

    if (
      canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)
    ) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render(ctx, snapshot, arenaRef.current, computeTransform(w, h));
  }, [snapshot, canvasSize]);

  function worldPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
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

  function handlePointer(event: PointerEvent<HTMLCanvasElement>) {
    if (!interactive) return;
    onAim(worldPoint(event));
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="arena-canvas"
        className={cn(
          "h-full w-full touch-none",
          interactive ? "cursor-crosshair" : "cursor-default"
        )}
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
      />
    </div>
  );
}

/**
 * Observe the canvas size for hi-DPI rendering (mirrors useGame's solo
 * measuring logic; depends on the snapshot being available so it re-runs
 * once the arena has actually mounted).
 */
function useCanvasSize(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  mounted: boolean
) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasRef, mounted]);
  return size;
}
