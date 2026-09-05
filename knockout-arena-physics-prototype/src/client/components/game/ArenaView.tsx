import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { createArena, type GameStateSnapshot } from "../../../game";
import { computeTransform, render } from "../../renderer";
import {
  INTERPOLATION_DELAY_MS,
  SnapshotBuffer,
  interpolateSnapshot,
  nowMs,
} from "../../interpolation";
import { Vfx, prefersReducedMotion } from "../../effects";
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
 *
 * Draw smoothing (render-only): authoritative snapshots arrive as discrete
 * pushes, so remote pawns would visibly step at the network cadence. Each
 * push is stamped with its arrival time into a bounded buffer, and the
 * arena draws remote pawn positions BETWEEN the two bracketing snapshots
 * (see src/client/interpolation.ts). The local pawn, the aiming phase, the
 * finished phase and every state boundary snap to the newest authoritative
 * state — no prediction, no extrapolation, and nothing about the smoothed
 * positions ever leaves the draw path. The buffer and the latest snapshot
 * live in refs: the animation loop repaints the canvas directly and never
 * touches React state, so interpolation adds no re-renders.
 *
 * Visual effects (render-only, Task 18): every authoritative push is also
 * diffed against its predecessor by a Vfx instance (launch bursts,
 * eliminations, winner celebration, round-start pulse, impacts, shake —
 * see src/client/effects.ts), and the draw path layers the baked effect
 * frame UNDER the pawns. Screen shake is applied by adding a tiny
 * decaying offset to the RENDER transform only — the pointer → world
 * conversion keeps using the unshaken computeTransform, so aiming
 * coordinates are never affected.
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

  // --- Render-only interpolation state (refs — the draw loop must never
  // cause React updates; see the component doc comment). ---
  const bufferRef = useRef<SnapshotBuffer>(new SnapshotBuffer());
  const latestRef = useRef<GameStateSnapshot>(snapshot);
  const canvasSizeRef = useRef(canvasSize);
  // --- Render-only effects state (same discipline: refs, no React state). ---
  const vfxRef = useRef<Vfx>(
    new Vfx({ reducedMotion: prefersReducedMotion(), arena: arenaRef.current })
  );
  const prevSnapshotRef = useRef<GameStateSnapshot | null>(null);
  // Last painted frame, so identical frames (static scenes, no motion
  // between a pair) are skipped instead of repainted every display frame.
  const lastFrameRef = useRef<{
    visual: GameStateSnapshot;
    width: number;
    height: number;
    dpr: number;
  } | null>(null);
  // Written during render deliberately: the callbacks below read the newest
  // snapshot/canvas size through refs without depending on them.
  latestRef.current = snapshot;
  canvasSizeRef.current = canvasSize;

  /** Paint one frame: the interpolated visual state + render-only effects. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const latest = latestRef.current;
    if (!canvas || latest === null) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvasSizeRef.current.width;
    const h = canvasSizeRef.current.height;
    if (w === 0 || h === 0) return;

    let resized = false;
    if (
      canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)
    ) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      resized = true;
    }

    const now = nowMs();
    const visual = interpolateSnapshot(
      bufferRef.current,
      now - INTERPOLATION_DELAY_MS,
      latest
    );

    // Any effect still animating forces a repaint (fading trails, flying
    // particles, decaying shake) — static scenes stay at zero extra paints.
    const effectsActive = vfxRef.current.hasActivity(now);

    // Skip the repaint when nothing observable changed since the last one
    // (same visual object AND same geometry). Resizing the backing store
    // clears the canvas, so a resize always repaints.
    const last = lastFrameRef.current;
    if (
      !resized &&
      !effectsActive &&
      last !== null &&
      last.visual === visual &&
      last.width === w &&
      last.height === h &&
      last.dpr === dpr
    ) {
      return;
    }
    lastFrameRef.current = { visual, width: w, height: h, dpr };

    // Effects: sample trails from the RENDERED positions, then bake the
    // frame (particle physics advance + expiry happen inside).
    vfxRef.current.sampleTrails(visual, now);
    const effects = vfxRef.current.buildFrame(now);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Screen shake rides the RENDER transform (a few CSS px, decaying) so
    // no new canvas calls and no input-path involvement: worldPoint below
    // keeps using the unshaken computeTransform for aiming.
    const shake = vfxRef.current.shakeOffset(now);
    const transform = computeTransform(w, h);
    const shaken =
      shake.x !== 0 || shake.y !== 0
        ? {
            ...transform,
            offsetX: transform.offsetX + shake.x,
            offsetY: transform.offsetY + shake.y,
          }
        : transform;
    render(ctx, visual, arenaRef.current, shaken, effects);
  }, []);

  // Every authoritative push: stamp it into the buffer, diff it against
  // the previous push for one-shot effects, and reflect it immediately.
  // This is also the complete draw path wherever requestAnimationFrame is
  // unavailable (e.g. jsdom) — behavior identical to a push-driven
  // repaint, just with interpolated positions.
  useEffect(() => {
    const now = nowMs();
    bufferRef.current.push(snapshot, now);
    vfxRef.current.observe(prevSnapshotRef.current, snapshot, now);
    prevSnapshotRef.current = snapshot;
    draw();
  }, [snapshot, draw]);

  // Canvas (re)measured: repaint the current visual state.
  useEffect(() => {
    draw();
  }, [canvasSize, draw]);

  // Display-cadence repaint (browsers): between pushes, advance the
  // interpolation clock every frame so remote pawns glide instead of
  // stepping at the network cadence. Pure canvas work — no React state.
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    let handle = requestAnimationFrame(frame);
    function frame() {
      handle = requestAnimationFrame(frame);
      draw();
    }
    return () => cancelAnimationFrame(handle);
  }, [draw]);

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

  // Right-click aiming: the browser's context menu must not steal the
  // interaction ON THE ARENA. Scoped to this canvas only — nothing global,
  // so the rest of the page (and the lobby) keeps its normal menus.
  function handleContextMenu(event: MouseEvent<HTMLCanvasElement>) {
    event.preventDefault();
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
        onContextMenu={handleContextMenu}
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
