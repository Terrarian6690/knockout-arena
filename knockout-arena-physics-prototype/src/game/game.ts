import Matter from "matter-js";
import { CONFIG } from "./config";
import { createPhysicsWorld, type PhysicsWorld } from "./physics";
import { spawnPositionAtAngle } from "./arena";
import { createPlayer, type Player } from "./player";
import { createAimState, aimAt, launchVelocity, type AimState } from "./aiming";
import {
  createTurnState,
  advanceTurn,
  activePawnId,
  checkSettled,
  type TurnState,
} from "./turnLogic";
import type {
  GameAction,
  GameStateSnapshot,
  GamePhase,
  PawnSnapshot,
} from "./types";

/**
 * Core game engine (orchestrator).
 *
 * Owns the game state, turn logic, and physics. It exposes:
 *   - dispatch(action) — feed UI input
 *   - update(dtMs) — advance one frame (called from the RAF loop)
 *   - snapshot() — current state for rendering / UI
 *
 * It deliberately does NOT know about React, canvas, or networking. A future
 * network layer can drive `dispatch` from server messages and read `snapshot`
 * for authority, without changing this class's responsibilities.
 */
export interface GameHandle {
  dispatch(action: GameAction): void;
  update(dtMs: number): void;
  snapshot(): GameStateSnapshot;
  subscribe(listener: (s: GameStateSnapshot) => void): () => void;
  destroy(): void;
}

export function createGame(): GameHandle {
  const physics: PhysicsWorld = createPhysicsWorld();
  const arena = physics.arena;

  // Single player for phase 1, spawned near the top edge of the arena.
  const spawnAngle = -Math.PI / 2;
  const [spawnX, spawnY] = spawnPositionAtAngle(arena, spawnAngle);

  const players: Player[] = [
    createPlayer({
      id: "p0",
      name: "Player 1",
      colorIndex: 0,
      spawnX,
      spawnY,
    }),
  ];

  // Map player id -> physics body.
  const bodies = new Map<string, Matter.Body>();
  for (const p of players) {
    bodies.set(p.id, physics.createPawnBody(p.id, p.spawnX, p.spawnY, p.radius));
  }

  const turn: TurnState = createTurnState(players.map((p) => p.id));
  const aim: AimState = createAimState();

  let power: number = CONFIG.power.default;
  let phase: GamePhase = "aiming";
  let listeners: ((s: GameStateSnapshot) => void)[] = [];
  let lastEmit = 0;

  /**
   * Knockout detection. The rim is solid and pawns bump off it during normal
   * play; but a strong launch aimed at the edge shoves the pawn over the rim.
   * We detect that by checking the pawn's outward radial speed at the moment it
   * contacts the arena wall.
   */
  physics.onCollision((a, b) => {
    if (phase !== "moving") return;

    const aLabel = physics.label(a);
    const bLabel = physics.label(b);

    const pawnBody = aLabel.startsWith("pawn:") ? a : bLabel.startsWith("pawn:") ? b : null;
    const wallBody = (aLabel === "arenaWall" ? a : bLabel === "arenaWall" ? b : null);

    if (!pawnBody || !wallBody) return;

    const id = (pawnBody === a ? aLabel : bLabel).slice("pawn:".length);
    const player = players.find((p) => p.id === id);
    if (!player || player.eliminated) return;

    const pos = physics.position(pawnBody);
    const vel = physics.velocity(pawnBody);

    // Outward radial unit vector from arena center.
    const dx = pos.x - arena.centerX;
    const dy = pos.y - arena.centerY;
    const dist = Math.hypot(dx, dy) || 1;
    const outwardX = dx / dist;
    const outwardY = dy / dist;

    const outwardSpeed = vel.x * outwardX + vel.y * outwardY;
    if (outwardSpeed >= CONFIG.launch.knockoutSpeed) {
      eliminatePawn(player, pawnBody);
    }
  });

  function eliminatePawn(player: Player, body: Matter.Body) {
    player.eliminated = true;
    physics.stop(body);
    setPhase("eliminated");
    emit();
  }

  function emit() {
    const s = snapshot();
    for (const l of listeners) l(s);
  }

  function snapshot(): GameStateSnapshot {
    const active = activePawnId(turn);
    const pawns: PawnSnapshot[] = players.map((p) => {
      const body = bodies.get(p.id);
      const pos = body ? physics.position(body) : { x: p.spawnX, y: p.spawnY };
      const vel = body ? physics.velocity(body) : { x: 0, y: 0 };
      return {
        id: p.id,
        position: { x: pos.x, y: pos.y },
        velocity: { x: vel.x, y: vel.y },
        radius: p.radius,
        eliminated: p.eliminated,
        isMoving: phase === "moving" && p.id === active,
        colorIndex: p.colorIndex,
      };
    });

    return {
      phase,
      pawns,
      localPawnId: "p0",
      power,
      aimDirection: aim.active ? { ...aim.direction } : null,
      isAiming: aim.active && phase === "aiming",
      activePawnId: active,
    };
  }

  function setPhase(next: GamePhase) {
    phase = next;
  }

  function onAim(x: number, y: number) {
    if (phase !== "aiming") return;
    const active = activePawnId(turn);
    const body = active ? bodies.get(active) : undefined;
    if (!body) return;
    const pos = physics.position(body);
    const dir = aimAt({ x: pos.x, y: pos.y }, { x, y });
    if (dir) {
      aim.direction = dir;
      aim.active = true;
    }
  }

  function onSetPower(value: number) {
    power = Math.max(CONFIG.power.min, Math.min(CONFIG.power.max, Math.round(value)));
  }

  function onConfirmLaunch() {
    if (phase !== "aiming") return;
    const active = activePawnId(turn);
    const body = active ? bodies.get(active) : undefined;
    if (!body) return;

    const dir = aim.active ? aim.direction : { x: 0, y: -1 };
    const vel = launchVelocity(dir, power);
    physics.applyImpulse(body, vel.x, vel.y);
    turn.settleTicks = 0;
    turn.moving = true;
    setPhase("moving");
    emit();
  }

  function onReset() {
    for (const p of players) {
      const body = bodies.get(p.id);
      if (body) {
        // Reposition the body to spawn and zero velocity.
        Matter.Body.setPosition(body, { x: p.spawnX, y: p.spawnY });
        physics.stop(body);
      }
      p.eliminated = false;
    }
    turn.activeIndex = 0;
    turn.settleTicks = 0;
    turn.moving = false;
    aim.active = false;
    power = CONFIG.power.default;
    setPhase("aiming");
    emit();
  }

  function update(dtMs: number) {
    if (phase === "moving") {
      physics.step(dtMs);

      const active = activePawnId(turn);
      const body = active ? bodies.get(active) : undefined;
      const player = players.find((p) => p.id === active);

      // The collision handler may have eliminated the pawn during the step.
      if (player?.eliminated) return;

      if (body && player) {
        const vel = physics.velocity(body);
        const speed = Math.hypot(vel.x, vel.y);

        // Elimination is handled by the wall-collision handler (knockout).
        // Check settling.
        turn.settleTicks += 1;
        const { settled } = checkSettled(speed, turn.settleTicks);
        if (settled) {
          physics.stop(body);
          turn.moving = false;

          // For phase 1 there is only one pawn; wrap back to aiming. (When
          // multiplayer is added, `advanceTurn` will route to the next actor.)
          advanceTurn(turn);
          setPhase("aiming");
          aim.active = false;
          emit();
          return;
        }
      }
    }

    // Keep the UI in sync. During "moving" we emit every frame so the canvas
    // animates smoothly; aiming only needs occasional emits (mouse events
    // already trigger their own).
    if (phase === "moving") {
      emit();
    } else {
      const now = performance.now();
      if (now - lastEmit > 100) {
        lastEmit = now;
        emit();
      }
    }
  }

  function dispatch(action: GameAction) {
    switch (action.type) {
      case "aim":
        onAim(action.x, action.y);
        emit();
        break;
      case "setPower":
        onSetPower(action.power);
        emit();
        break;
      case "confirmLaunch":
        onConfirmLaunch();
        break;
      case "reset":
        onReset();
        break;
    }
  }

  function subscribe(listener: (s: GameStateSnapshot) => void) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  function destroy() {
    listeners = [];
    Matter.Engine.clear(physics.engine);
  }

  // Emit initial state.
  emit();

  return { dispatch, update, snapshot, subscribe, destroy };
}
