import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { arenaFromSnapshot, type GameStateSnapshot } from "../../../game";
import { computeTransform, render } from "../../renderer";
import {
  INTERPOLATION_DELAY_MS,
  SnapshotBuffer,
  interpolateSnapshot,
  nowMs,
} from "../../interpolation";
import { Vfx, prefersReducedMotion } from "../../effects";
import { audio } from "../../audio";
import { cn } from "../../utils/cn";
import { ArenaStateDescription } from "./ArenaStateDescription";

/** One full fade-out-and-back of the shrink preview ring, in ms. */
export const SHRINK_PULSE_PERIOD_MS = 1_600;

/**
 * The shrink preview's intensity at a moment in time: a smooth 1 → 0 → 1
 * oscillation (raised cosine).
 *
 * Pure function of the clock, so it is identical on every client and
 * needs no stored phase — a reconnecting player picks it up mid-breath
 * rather than restarting it. It varies OPACITY only; the ring's radius
 * and dash pattern never move, which is what keeps the preview readable
 * as a fixed target rather than something sweeping across the floor.
 */
export function shrinkPreviewPulse(nowMs: number): number {
  const phase = (nowMs % SHRINK_PULSE_PERIOD_MS) / SHRINK_PULSE_PERIOD_MS;
  return (1 + Math.cos(2 * Math.PI * phase)) / 2;
}

/** DOM id linking the canvas to its text alternative (Task 12). */
const ARENA_DESCRIPTION_ID = "arena-state-description";

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
 * Click-to-lock aiming: while unlocked the arrow follows the mouse
 * normally, but a PRIMARY-button click on the arena selects the current
 * direction and LOCKS it — later mouse movement no longer re-aims, so
 * the trip towards the Confirm button cannot disturb the choice.
 * Clicking the arena again selects and locks a new direction. The lock
 * is input gating only (the server keeps full authority over the stored
 * aim — every selection is still sent as a normal aim intent) and it
 * lives only while the player may act: confirming, resolving, finishing
 * or disconnecting clears it, so every fresh aiming round starts
 * unlocked. Other mouse buttons (right-click aim) select a direction
 * without locking, exactly as before.
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
 * Sound (render-only, Task 19): the same per-push VFX event diff feeds
 * the client-side audio manager — one detector, two consumers. A pointer
 * press on the canvas doubles as the audio unlock gesture.
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
  /**
   * Seat id of the room host, for the canvas's text alternative
   * (Task 12). Display data only — never used for input decisions.
   */
  readonly hostPlayerId?: string | null;
}

export function ArenaView({
  snapshot,
  interactive,
  onAim,
  hostPlayerId = null,
}: ArenaViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The arena GEOMETRY IS AUTHORITATIVE STATE, not a constant: it shrinks
  // during a match, so it is derived from the latest snapshot on every
  // draw instead of being frozen in a ref. The ref below holds only the
  // most recent one, for the pointer-mapping fallback and the VFX
  // instance (which needs a center at construction time).
  const arenaRef = useRef(arenaFromSnapshot(snapshot));
  arenaRef.current = arenaFromSnapshot(snapshot);
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
  // Read once, like the Vfx flag above: a ref so the draw loop never
  // re-subscribes and never triggers a React update.
  const reducedMotionRef = useRef(prefersReducedMotion());
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
    //
    // The pulsing shrink preview is animation too: without this the
    // frame-skip below would hold the ring at one opacity for the whole
    // round, because the snapshot object never changes while aiming.
    // Reduced motion draws a constant ring, so it deliberately does NOT
    // force repaints — it stays at zero extra paints, as before.
    const previewPulsing =
      !reducedMotionRef.current && visual.arena?.shrinkWarning === true;
    const effectsActive = vfxRef.current.hasActivity(now) || previewPulsing;

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
    // Draw the arena the AUTHORITATIVE snapshot describes — the floor
    // follows the server's radius, so a shrink is visible the moment its
    // snapshot arrives (and never before).
    //
    // The shrink preview ring pulses between full intensity and fully
    // invisible. The oscillation is computed from the wall clock rather
    // than stored, so it cannot drift or survive a reconnect, and under
    // prefers-reduced-motion it is pinned to full strength: the same
    // ring, at the same radius, simply not animating.
    render(
      ctx,
      visual,
      arenaFromSnapshot(visual),
      shaken,
      effects,
      reducedMotionRef.current ? 1 : shrinkPreviewPulse(now)
    );
  }, []);

  // Every authoritative push: stamp it into the buffer, diff it against
  // the previous push for one-shot effects, and reflect it immediately.
  // This is also the complete draw path wherever requestAnimationFrame is
  // unavailable (e.g. jsdom) — behavior identical to a push-driven
  // repaint, just with interpolated positions.
  useEffect(() => {
    const now = nowMs();
    bufferRef.current.push(snapshot, now);
    // The single event detector: VFX spawn from these authoritative
    // transitions, and the same batch feeds the (render-only) sounds.
    const events = vfxRef.current.observe(prevSnapshotRef.current, snapshot, now);
    prevSnapshotRef.current = snapshot;
    if (events.length > 0) audio.play(events);
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

  // The click-to-lock aim gate (see handlePointer): a ref, because the
  // lock changes no rendering by itself — it only decides whether mouse
  // movement reaches onAim. It lives only while the player may act: the
  // moment input is refused (confirmed, round resolving, match over,
  // disconnected) the lock clears — the same discipline MultiplayerGame
  // applies to its optimistic preview — so every fresh aiming round
  // (which always starts from a refused-input state) begins unlocked.
  const aimLockedRef = useRef(false);
  useEffect(() => {
    if (!interactive) aimLockedRef.current = false;
  }, [interactive]);

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
    // A real pointer press on the arena is a legitimate user gesture —
    // the moment browsers allow audio to start. Never blocks input.
    if (event.type === "pointerdown") audio.unlock();
    if (!interactive) return;
    if (event.type === "pointerdown") {
      // Every arena click selects the direction under the cursor — and a
      // PRIMARY-button click additionally LOCKS it: later mouse movement
      // no longer re-aims until a fresh aiming round. Other buttons keep
      // the old follow behavior (select without locking).
      onAim(worldPoint(event));
      if (event.button === 0) aimLockedRef.current = true;
      return;
    }
    if (aimLockedRef.current) return; // locked: the arrow stays put
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
        // The canvas is a picture of the match, so it gets a name and a
        // text alternative describing the PUBLIC board state (Task 12).
        // `img` is the honest role here: this element conveys content
        // but takes no keyboard interaction of its own.
        role="img"
        aria-label="Arena"
        aria-describedby={ARENA_DESCRIPTION_ID}
        className={cn(
          "h-full w-full touch-none",
          interactive ? "cursor-crosshair" : "cursor-default"
        )}
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        onContextMenu={handleContextMenu}
      />
      {/* Visually hidden; rebuilt only when the described state
          changes, never on plain snapshot ticks. */}
      <ArenaStateDescription
        id={ARENA_DESCRIPTION_ID}
        snapshot={snapshot}
        hostPlayerId={hostPlayerId}
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
