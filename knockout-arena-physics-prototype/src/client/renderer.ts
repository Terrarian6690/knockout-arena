import { CONFIG, arenaEdgeRadius, createArena, playerColor, playerStroke, indicatorLength, type Arena, type GameStateSnapshot } from "../game";
import type { EffectFrame } from "./effects";

/**
 * Rendering module — pure canvas drawing, no game logic.
 *
 * The renderer is given a snapshot of state and draws it. This separation lets
 * us reuse the renderer for spectating, replays, or a server preview later.
 *
 * The optional `effects` frame (Task 18) is baked visual-only data produced
 * by src/client/effects.ts: trails, rings and particles drawn UNDER the
 * pawns/indicators, plus a persistent winner halo derived from the
 * AUTHORITATIVE snapshot (finished phase + winnerId — never an effect-side
 * guess). Callers that pass nothing (e.g. the solo screen) render exactly
 * as before.
 */
/** Dash count around the preview ring — constant at every radius. */
const PREVIEW_DASHES = 36;
/** Aim/launch arrow shaft width, in world units. */
const SHAFT_WIDTH = 2.5;
/** Preview ring stroke width, in world units. */
const PREVIEW_LINE_WIDTH = 3;

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Scale factor from world units to screen pixels. */
  scale: number;
  /** World offset applied to center the world in the canvas. */
  offsetX: number;
  offsetY: number;
}

export function computeTransform(
  canvasWidth: number,
  canvasHeight: number
): { scale: number; offsetX: number; offsetY: number } {
  const w = CONFIG.world.width;
  const h = CONFIG.world.height;
  const scale = Math.min(canvasWidth / w, canvasHeight / h);
  return {
    scale,
    offsetX: (canvasWidth - w * scale) / 2,
    offsetY: (canvasHeight - h * scale) / 2,
  };
}

export function render(
  ctx: CanvasRenderingContext2D,
  snapshot: GameStateSnapshot,
  arena: Arena,
  transform: { scale: number; offsetX: number; offsetY: number },
  effects?: EffectFrame,
  /**
   * Shrink-preview intensity, 0..1 (default 1 = full strength). The
   * caller owns the oscillation so the renderer stays a pure function of
   * its arguments: same inputs, same pixels. Reduced-motion callers
   * simply never vary it.
   */
  previewPulse = 1
) {
  const { scale, offsetX, offsetY } = transform;

  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Dark background (outside the arena).
  ctx.fillStyle = CONFIG.colors.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  drawArena(ctx, arena);

  // The shrink preview sits on the floor, under the effects and pawns:
  // it is scenery being announced, never something that can hide a pawn.
  // Both the decision and the radius come from the authoritative
  // snapshot — see drawShrinkPreview.
  if (snapshot.arena?.shrinkWarning === true) {
    const next = snapshot.arena.nextRadius;
    if (typeof next === "number" && Number.isFinite(next)) {
      drawShrinkPreview(ctx, arena, next, previewPulse);
    }
  }

  // Visual effects sit between the arena floor and every gameplay element:
  // trails deepest, then rings, then particles — nothing may obscure the
  // pawns, aim indicators or launch arrows.
  if (effects) {
    drawEffectsBehind(ctx, effects);
  }

  // Draw the viewer's own aim indicator under the pawns (simultaneous
  // rounds: every player sees their own current-round selection).
  if (snapshot.isAiming && snapshot.aimDirection) {
    const local = snapshot.pawns.find((p) => p.id === snapshot.localPawnId);
    if (local && snapshot.phase === "aiming") {
      drawAimIndicator(ctx, local.position.x, local.position.y, snapshot.aimDirection, snapshot.power);
    }
  }

  // Reveal: once the round is resolving, every committed launch becomes
  // public — one arrow per confirmed launcher, drawn under the pawns in
  // the pawn's own color. Unconfirmed pawns have no launch datum (null),
  // so they get no arrow — never a guessed one. (The projection already
  // nulls launches during "aiming"; the phase check is defense-in-depth
  // for hand-fed snapshots.)
  if (snapshot.phase !== "aiming") {
    for (const pawn of snapshot.pawns) {
      if (pawn.launch) {
        drawLaunchIndicator(ctx, pawn);
      }
    }
  }

  // Draw pawns.
  for (const pawn of snapshot.pawns) {
    drawPawn(ctx, pawn, snapshot);
  }

  // Winner halo: a pure render rule from the AUTHORITATIVE verdict — the
  // finished phase plus the server's winnerId. Static (no animation, no
  // extra repaints), subtle, and it cannot appear for a non-winner.
  if (snapshot.phase === "finished" && snapshot.winnerId) {
    const winner = snapshot.pawns.find((p) => p.id === snapshot.winnerId);
    if (winner && !winner.eliminated) {
      drawWinnerHalo(ctx, winner.position.x, winner.position.y, winner.radius);
    }
  }

  ctx.restore();
}

/** Trails → rings → particles, all under the gameplay layer. */
function drawEffectsBehind(ctx: CanvasRenderingContext2D, effects: EffectFrame) {
  for (const dot of effects.trails) {
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.globalAlpha = dot.alpha;
    ctx.fillStyle = dot.color;
    ctx.fill();
  }
  for (const ring of effects.rings) {
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.globalAlpha = ring.alpha;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = ring.width;
    ctx.stroke();
  }
  for (const dot of effects.particles) {
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.globalAlpha = dot.alpha;
    ctx.fillStyle = dot.color;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** The champion's crown: two thin accent rings around the winner pawn. */
function drawWinnerHalo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.strokeStyle = "#ffd166";
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.arc(x, y, r + 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}


/**
 * Draw the arena at the radius it was HANDED — which is the authoritative
 * one (callers derive it from the snapshot via arenaFromSnapshot). The
 * whole drawing is relative to `arena.radius`, so the shrinking arena
 * needs no special drawing path: a smaller radius simply paints a smaller
 * floor, centered exactly as before.
 *
 * NO BOUNDARY RING (Task 30). The arena used to be finished with three
 * separate edge marks: an opaque `arenaWall` band filled between the
 * floor and `arena.radius`, a 2px `arenaWallGlow` stroke on the floor
 * edge, and a faint outer line. All three are gone — outside a shrink
 * preview the floor simply fades into the background.
 *
 * The floor is now painted out to `arena.radius` itself rather than to
 * `radius - wallThickness`. That is deliberate and it is what makes the
 * removal honest: the elimination rule kills a pawn when its CENTER
 * passes `floorRadius + pawnRadius`, which is exactly `arena.radius`
 * (the wall band was precisely one pawn radius wide). Drawing the floor
 * to the smaller radius while removing the band that used to cover the
 * difference would have left pawns visibly dying a pawn-width out over
 * empty space. The visible edge and the lethal edge are now the same
 * circle at every size: 330, 290, 250, 210, 180.
 */
function drawArena(ctx: CanvasRenderingContext2D, arena: Arena) {
  const cx = arena.centerX;
  const cy = arena.centerY;
  const edge = arenaEdgeRadius(arena);

  // THE PLATFORM. A solid blue disc out to the visible edge, so the
  // arena reads as a surface you stand on rather than a faint gradient
  // in the dark. (Task 30 removed this fill along with the boundary
  // ring, which went too far: the ring is what had to go, not the
  // platform itself.) The grid rings below are drawn ON TOP of it for
  // depth — the old code painted this disc over them, which is why they
  // were never visible.
  ctx.beginPath();
  ctx.arc(cx, cy, edge, 0, Math.PI * 2);
  ctx.fillStyle = CONFIG.colors.arenaWall;
  ctx.fill();

  // Floor gradient inside the platform: darker towards the rim, so the
  // surface has some depth instead of reading as a flat sticker.
  const g = ctx.createRadialGradient(cx, cy, edge * 0.2, cx, cy, edge);
  g.addColorStop(0, CONFIG.colors.arenaFloorInner);
  g.addColorStop(1, CONFIG.colors.arenaFloor);
  ctx.beginPath();
  ctx.arc(cx, cy, edge, 0, Math.PI * 2);
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Subtle grid rings for depth, now genuinely visible on the platform.
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let r = edge * 0.25; r < edge; r += edge * 0.25) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // A soft rim so the platform's edge is legible against the background
  // WITHOUT reinstating the hard white boundary ring Task 30 removed.
  ctx.beginPath();
  ctx.arc(cx, cy, edge, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(126,168,209,0.22)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * The shrink PREVIEW ring: where the floor is about to be.
 *
 * Drawn only while the authoritative snapshot says a shrink lands when
 * this round resolves (`arena.shrinkWarning`) and names the radius it
 * will land at (`arena.nextRadius`). Both come from the server's own
 * schedule projection, so the client never counts rounds, never knows
 * the shrink interval, and cannot preview at the wrong moment: when the
 * shrink happens the flag clears in the very same snapshot that carries
 * the new radius, and at the minimum radius it is never set at all.
 *
 * `pulse` is a 0..1 intensity supplied by the caller (1 = full strength).
 * The ring's geometry never depends on it — only its opacity — so a
 * reduced-motion client pinned at 1 sees the identical ring, just still.
 */
function drawShrinkPreview(
  ctx: CanvasRenderingContext2D,
  arena: Arena,
  nextRadius: number,
  pulse: number
) {
  // Same center and the same clamping the rest of the arena geometry
  // uses — never a hardcoded circle.
  const target = createArena(nextRadius);
  const r = arenaEdgeRadius(target);
  if (!(r > 0)) return;

  const alpha = Math.max(0, Math.min(1, pulse));
  if (alpha <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(arena.centerX, arena.centerY, r, 0, Math.PI * 2);
  // Dash lengths scale with the circle so every preview radius gets the
  // same dash COUNT — the pattern reads identically at 290 and at 180.
  const dash = (2 * Math.PI * r) / PREVIEW_DASHES;
  ctx.setLineDash([dash * 0.55, dash * 0.45]);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = CONFIG.colors.outOfBounds;
  ctx.lineWidth = PREVIEW_LINE_WIDTH;
  ctx.stroke();
  ctx.restore();
  // Proxy-based test contexts do not implement save/restore state, so
  // reset the two properties that would otherwise leak into later draws.
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawPawn(
  ctx: CanvasRenderingContext2D,
  pawn: GameStateSnapshot["pawns"][number],
  snapshot: GameStateSnapshot
) {
  const { x, y } = pawn.position;
  const r = pawn.radius;

  // Simultaneous rounds: highlight the viewer's own, still-deciding pawn
  // (there is no single acting pawn — everyone chooses at once).
  const isActive = pawn.isLocal && !pawn.confirmed;
  const fill = playerColor(pawn.colorIndex);
  const stroke = playerStroke(pawn.colorIndex);

  // Shadow for depth.
  ctx.beginPath();
  ctx.arc(x + 2, y + 3, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fill();

  // Body.
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  // Highlight (top-left specular).
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fill();

  // Active pulse ring.
  if (isActive && snapshot.phase === "aiming") {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Eliminated tint.
  if (pawn.eliminated) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(239,68,68,0.5)";
    ctx.fill();
  }
}

/**
 * Colors + emphasis of one indicator shaft. The local live aim uses the
 * shared amber; a revealed committed launch uses the launching player's
 * own palette color, slightly stronger (it is now committed fact).
 */
interface IndicatorStyle {
  lineColor: string;
  arrowColor: string;
  alpha: number;
}

/**
 * The viewer's OWN live aim indicator: dashed shaft + power chevrons +
 * arrowhead, length ∝ power. Pure presentation of the projection's
 * aimDirection/power — no trajectory prediction.
 */
function drawAimIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: { x: number; y: number },
  power: number
) {
  drawIndicator(ctx, x, y, direction, power, {
    lineColor: CONFIG.colors.aimLine,
    arrowColor: CONFIG.colors.aimArrow,
    // Higher power → longer, more opaque indicator.
    alpha: 0.55 + 0.09 * power,
  });
}

/**
 * A REVEALED committed launch, drawn attached to its (moving) pawn in the
 * player's own color: same geometry as the live aim — direction is the
 * confirmed launch direction, length ∝ the confirmed power — so a
 * revealed arrow reads exactly like the aim arrows it is the answer to.
 */
function drawLaunchIndicator(
  ctx: CanvasRenderingContext2D,
  pawn: GameStateSnapshot["pawns"][number]
) {
  drawIndicator(
    ctx,
    pawn.position.x,
    pawn.position.y,
    pawn.launch!.direction,
    pawn.launch!.power,
    {
      lineColor: playerColor(pawn.colorIndex),
      arrowColor: playerColor(pawn.colorIndex),
      alpha: 0.9,
    }
  );
}

/**
 * Shared indicator geometry: ONE continuous arrow — a solid shaft and a
 * filled head, nothing else.
 *
 * It used to be a dashed shaft with a row of chevrons marching along it,
 * which at a glance read as a trail of separate marks rather than as a
 * single pointer. The chevrons also carried a power cue (more power →
 * more chevrons); that cue is not lost, because the arrow's LENGTH is
 * still proportional to power, and the head still grows with it.
 *
 * The shaft is drawn with a butt cap and run to the exact tip, where the
 * head is drawn over its last stretch: the two overlap, so they join
 * seamlessly instead of leaving a notch (a round cap would poke out past
 * the point of the head).
 */
function drawIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: { x: number; y: number },
  power: number,
  style: IndicatorStyle
) {
  const len = indicatorLength(power) + CONFIG.pawn.radius + 4;
  const tipX = x + direction.x * len;
  const tipY = y + direction.y * len;
  const angle = Math.atan2(direction.y, direction.x);

  ctx.save();
  ctx.globalAlpha = style.alpha;

  // The shaft: one unbroken stroke from the pawn's edge to the tip.
  ctx.beginPath();
  ctx.moveTo(x + direction.x * (CONFIG.pawn.radius + 2), y + direction.y * (CONFIG.pawn.radius + 2));
  ctx.lineTo(tipX, tipY);
  ctx.strokeStyle = style.lineColor;
  ctx.lineWidth = SHAFT_WIDTH;
  ctx.lineCap = "butt";
  ctx.stroke();

  // Arrowhead (grows slightly with power).
  const head = 9 + power;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - head * Math.cos(angle - Math.PI / 6),
    tipY - head * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    tipX - head * Math.cos(angle + Math.PI / 6),
    tipY - head * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fillStyle = style.arrowColor;
  ctx.fill();
  ctx.restore();
}
