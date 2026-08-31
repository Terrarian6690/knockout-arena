import Matter from "matter-js";
import { CONFIG } from "./config";
import { createPhysicsWorld, type PhysicsWorld } from "./physics";
import { spawnPositionAtAngle, isPawnOutOfBounds, floorRadius } from "./arena";
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
  GamePhase,
  GameStateSnapshot,
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
 *
 * Simulation timing: `update` receives real frame time and exchanges it for
 * fixed `CONFIG.simulation.fixedTimestepMs` ticks via an accumulator, so the
 * physics behaves identically regardless of display refresh rate. All
 * per-tick decisions (elimination, settling) happen inside those fixed ticks.
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
  let listeners: ((s: GameStateSnapshot) => void)[] = [];

  const FIXED_DT = CONFIG.simulation.fixedTimestepMs;
  let accumulator = 0;

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
        isMoving: turn.phase === "moving" && p.id === active,
        colorIndex: p.colorIndex,
      };
    });

    return {
      phase: turn.phase,
      pawns,
      localPawnId: "p0",
      power,
      aimDirection: aim.active ? { ...aim.direction } : null,
      isAiming: aim.active && turn.phase === "aiming",
      activePawnId: active,
    };
  }

  function setPhase(next: GamePhase) {
    turn.phase = next;
  }

  function onAim(x: number, y: number) {
    if (turn.phase !== "aiming") return;
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
    if (turn.phase !== "aiming") return;
    power = Math.max(CONFIG.power.min, Math.min(CONFIG.power.max, Math.round(value)));
  }

  function onConfirmLaunch() {
    if (turn.phase !== "aiming") return; // exactly one launch per turn
    const active = activePawnId(turn);
    const body = active ? bodies.get(active) : undefined;
    if (!body) return;

    const dir = aim.active ? aim.direction : { x: 0, y: -1 };
    const vel = launchVelocity(dir, power);
    physics.applyImpulse(body, vel.x, vel.y);
    aim.active = false; // the aim was consumed by this launch
    turn.settleTicks = 0;
    accumulator = 0;
    setPhase("moving");
    emit();
  }

  function onReset() {
    for (const p of players) {
      const body = bodies.get(p.id);
      if (body) {
        // Reposition the body to spawn, zero velocity, restore rim collision.
        Matter.Body.setPosition(body, { x: p.spawnX, y: p.spawnY });
        physics.stop(body);
        physics.setCollidesWithWalls(body, true);
      }
      p.eliminated = false;
    }
    turn.activeIndex = 0;
    turn.settleTicks = 0;
    aim.active = false;
    power = CONFIG.power.default;
    accumulator = 0;
    setPhase("aiming");
    emit();
  }

  /** Return control to the aiming state for the next turn. */
  function beginAiming() {
    advanceTurn(turn); // single pawn: wraps back to the same actor
    aim.active = false;
    setPhase("aiming");
  }

  /**
   * One fixed simulation tick.
   *
   * 1. Rim pass-over decision — BEFORE stepping (a pure function of position
   *    and velocity, so it is fully deterministic): the rim is a low lip. A
   *    pawn whose outward radial speed is at least `knockoutSpeed` as it
   *    reaches the rim flies over it (wall collision disabled for that pawn);
   *    slower or glancing contacts bounce off normally. The decision zone is
   *    widened by two max-speed steps so it always happens at least one tick
   *    before contact, and once a pawn's center is past the rim the walls
   *    stay off until reset.
   * 2. Step the physics by the fixed delta.
   * 3. Decide elimination (pure geometry) and settling from the result.
   */
  function tickSimulation() {
    const active = activePawnId(turn);
    const body = active ? bodies.get(active) : undefined;
    const player = players.find((p) => p.id === active);
    if (!body || !player) {
      beginAiming();
      return;
    }

    const rimContact = floorRadius(arena) - player.radius;
    const unlockZone = rimContact - CONFIG.launch.maxSpeed * 2 - 1;
    const pos = physics.position(body);
    const vel = physics.velocity(body);
    const dx = pos.x - arena.centerX;
    const dy = pos.y - arena.centerY;
    const dist = Math.hypot(dx, dy) || 1;
    const outwardSpeed = (vel.x * dx + vel.y * dy) / dist;
    const fliesOverRim =
      dist > unlockZone && outwardSpeed >= CONFIG.launch.knockoutSpeed;
    const alreadyPastRim = dist > rimContact;
    physics.setCollidesWithWalls(body, !fliesOverRim && !alreadyPastRim);

    physics.step(FIXED_DT);
    turn.settleTicks += 1;

    // Authoritative elimination check: pure arena geometry, every tick. The
    // pawn must have completely left the playable floor.
    const posAfter = physics.position(body);
    if (isPawnOutOfBounds(arena, posAfter.x, posAfter.y, player.radius)) {
      eliminatePawn(player, body);
      return;
    }

    const velAfter = physics.velocity(body);
    const speed = Math.hypot(velAfter.x, velAfter.y);
    const { settled } = checkSettled(speed, turn.settleTicks);
    if (settled) {
      physics.stop(body);
      beginAiming();
    }
  }

  /**
   * Advance the game by one animation frame. Frame time is converted into
   * fixed simulation ticks; large frame gaps (tab switches, GC pauses) are
   * clamped so the loop never tries to catch up in a spiral. When nothing is
   * moving this is a cheap no-op — no physics, no state emission.
   */
  function update(dtMs: number) {
    if (turn.phase !== "moving") {
      accumulator = 0;
      return;
    }

    accumulator += Math.min(dtMs, CONFIG.simulation.maxFrameMs);
    let stepped = false;
    while (accumulator >= FIXED_DT && turn.phase === "moving") {
      accumulator -= FIXED_DT;
      tickSimulation();
      stepped = true;
    }
    if (!stepped) return;
    if (turn.phase !== "moving") accumulator = 0;
    emit();
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
    // Push the current state immediately so a freshly mounted UI (e.g. the
    // React app) never has to wait for the next event to render something.
    listener(snapshot());
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  function destroy() {
    listeners = [];
    physics.destroy();
  }

  // Emit initial state.
  emit();

  return { dispatch, update, snapshot, subscribe, destroy };
}
