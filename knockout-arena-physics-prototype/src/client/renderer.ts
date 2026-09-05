import { CONFIG, floorRadius, playerColor, playerStroke, indicatorLength, type Arena, type GameStateSnapshot } from "../game";
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
  effects?: EffectFrame
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


function drawArena(ctx: CanvasRenderingContext2D, arena: Arena) {
  const cx = arena.centerX;
  const cy = arena.centerY;
  const outer = arena.radius;
  const inner = floorRadius(arena);

  // Floor gradient.
  const g = ctx.createRadialGradient(cx, cy, inner * 0.2, cx, cy, inner);
  g.addColorStop(0, CONFIG.colors.arenaFloorInner);
  g.addColorStop(1, CONFIG.colors.arenaFloor);
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  // Subtle grid rings for depth.
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let r = inner * 0.25; r < inner; r += inner * 0.25) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Boundary wall ring.
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.fillStyle = CONFIG.colors.arenaWall;
  ctx.fill();

  // Wall inner glow.
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.strokeStyle = CONFIG.colors.arenaWallGlow;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Outer border line.
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(126,168,209,0.4)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
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

/** Shared indicator geometry: dashed shaft, power chevrons, arrowhead. */
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

  // Dashed line.
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.moveTo(x + direction.x * (CONFIG.pawn.radius + 2), y + direction.y * (CONFIG.pawn.radius + 2));
  ctx.lineTo(tipX, tipY);
  ctx.strokeStyle = style.lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.setLineDash([]);

  // Power chevrons along the shaft: evenly spaced, so a stronger power
  // (longer indicator) shows more chevrons — "more power, harder launch"
  // is readable at a glance without predicting the landing spot.
  for (let d = CONFIG.pawn.radius + 14; d < len - 14; d += 14) {
    const cx = x + direction.x * d;
    const cy = y + direction.y * d;
    ctx.beginPath();
    ctx.moveTo(
      cx - 7 * Math.cos(angle - 0.45),
      cy - 7 * Math.sin(angle - 0.45)
    );
    ctx.lineTo(cx, cy);
    ctx.lineTo(
      cx - 7 * Math.cos(angle + 0.45),
      cy - 7 * Math.sin(angle + 0.45)
    );
    ctx.strokeStyle = style.arrowColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

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
