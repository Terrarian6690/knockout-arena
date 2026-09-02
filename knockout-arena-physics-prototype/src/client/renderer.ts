import { CONFIG, floorRadius, playerColor, playerStroke, indicatorLength, type Arena, type GameStateSnapshot } from "../game";

/**
 * Rendering module — pure canvas drawing, no game logic.
 *
 * The renderer is given a snapshot of state and draws it. This separation lets
 * us reuse the renderer for spectating, replays, or a server preview later.
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
  transform: { scale: number; offsetX: number; offsetY: number }
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

  // Draw the viewer's own aim indicator under the pawns (simultaneous
  // rounds: every player sees their own current-round selection).
  if (snapshot.isAiming && snapshot.aimDirection) {
    const local = snapshot.pawns.find((p) => p.id === snapshot.localPawnId);
    if (local && snapshot.phase === "aiming") {
      drawAimIndicator(ctx, local.position.x, local.position.y, snapshot.aimDirection, snapshot.power);
    }
  }

  // Draw pawns.
  for (const pawn of snapshot.pawns) {
    drawPawn(ctx, pawn, snapshot);
  }

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

function drawAimIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: { x: number; y: number },
  power: number
) {
  const len = indicatorLength(power) + CONFIG.pawn.radius + 4;
  const tipX = x + direction.x * len;
  const tipY = y + direction.y * len;
  const angle = Math.atan2(direction.y, direction.x);

  // Higher power → longer, more opaque indicator.
  ctx.save();
  ctx.globalAlpha = 0.55 + 0.09 * power;

  // Dashed line.
  ctx.setLineDash([8, 7]);
  ctx.beginPath();
  ctx.moveTo(x + direction.x * (CONFIG.pawn.radius + 2), y + direction.y * (CONFIG.pawn.radius + 2));
  ctx.lineTo(tipX, tipY);
  ctx.strokeStyle = CONFIG.colors.aimLine;
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
    ctx.strokeStyle = CONFIG.colors.aimArrow;
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
  ctx.fillStyle = CONFIG.colors.aimArrow;
  ctx.fill();
  ctx.restore();
}
