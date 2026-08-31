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
  GameStateSnapshot,
  GamePhase,
} from "./types";
import { validateCommand, type CommandResult, type GameCommand } from "./commands";
import {
  validateGameState,
  type GameState,
  type PawnState,
} from "./state";
import { projectSnapshot } from "./project";

/**
 * Core game engine (orchestrator) — the authoritative simulation.
 *
 * Owns the game state, turn logic, and physics. It exposes:
 *   - applyCommand(command) — validate + apply a player INTENT
 *   - update(dtMs) — advance one frame (called from a RAF or a server loop)
 *   - getState()/loadState() — full serializable state (reconstruction I/O)
 *   - snapshot() — client-facing projection for rendering
 *   - subscribe(listener) — state-change notifications
 *
 * Intended ownership model for the future multiplayer server:
 *
 *   receive command → validateCommand → applyCommand → update (fixed ticks)
 *   → getState → serializeGameState → send to clients
 *
 * The engine never accepts outcomes from outside: elimination, phase
 * transitions, collisions and settling are computed here and only here.
 * Clients (the React bridge in the UI layer) send commands and render
 * snapshots.
 *
 * It deliberately does NOT know about React, canvas, or networking.
 *
 * Simulation timing: `update` receives real frame time and exchanges it for
 * fixed `CONFIG.simulation.fixedTimestepMs` ticks via an accumulator, so the
 * physics behaves identically regardless of display refresh rate. All
 * per-tick decisions (elimination, settling) happen inside those fixed ticks.
 */
export interface GameHandle {
  /**
   * Validate and apply a player command. Returns acceptance or a
   * machine-readable rejection reason — a future server can forward this
   * verbatim as the command acknowledgement.
   */
  applyCommand(command: GameCommand): CommandResult;
  /**
   * Legacy alias of applyCommand that discards the result. Kept for the
   * React client bridge and existing call sites; new code should prefer
   * applyCommand.
   */
  dispatch(action: GameCommand): void;
  /** Advance the game by one animation frame (fixed-tick accumulator). */
  update(dtMs: number): void;
  /** Client-facing projection of the authoritative state. */
  snapshot(): GameStateSnapshot;
  /** Full serializable authoritative state (see state.ts). */
  getState(): GameState;
  /**
   * Replace the entire game state. The input is validated (trust boundary):
   * a future server may feed this with state received from storage or a
   * peer process. Rebuilding from state does not change simulation rules.
   */
  loadState(state: GameState): void;
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

  /**
   * Which pawn the local client controls — a pure presentation concern that
   * the engine reports in snapshots. In phase 1 there is exactly one pawn;
   * in the multiplayer phase this becomes client configuration.
   */
  const LOCAL_PAWN_ID = "p0";

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

  // ────────────────────────────────────────────────────────────────────────
  // Authoritative state I/O (serialization boundary)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Collect the complete authoritative state as plain, JSON-serializable
   * data. Matter.js bodies are read through the physics facade and reduced
   * to kinematics; no engine internals leak out.
   */
  function getState(): GameState {
    return {
      phase: turn.phase,
      power,
      aim: { active: aim.active, direction: { ...aim.direction } },
      turn: {
        queue: [...turn.queue],
        activeIndex: turn.activeIndex,
        settleTicks: turn.settleTicks,
      },
      pawns: players.map((p): PawnState => {
        const body = bodies.get(p.id);
        const k = body
          ? physics.bodyState(body)
          : {
              position: { x: p.spawnX, y: p.spawnY },
              velocity: { x: 0, y: 0 },
              angle: 0,
              angularVelocity: 0,
            };
        return {
          id: p.id,
          name: p.name,
          colorIndex: p.colorIndex,
          radius: p.radius,
          spawnX: p.spawnX,
          spawnY: p.spawnY,
          eliminated: p.eliminated,
          position: { ...k.position },
          velocity: { ...k.velocity },
          angle: k.angle,
          angularVelocity: k.angularVelocity,
        };
      }),
    };
  }

  /**
   * Replace the entire state. Bodies are reused where pawn ids match and
   * created/removed otherwise, so the engine is fully state-driven — a
   * future server can boot a match from a deserialized state (including
   * multi-pawn states). The rim pass-over collision flag needs no
   * serialization: it is re-derived from position + velocity before every
   * tick (see tickSimulation).
   */
  function loadState(next: GameState) {
    const s = validateGameState(next); // throws on malformed input

    const wanted = new Map(s.pawns.map((p) => [p.id, p]));
    for (const [id, body] of bodies) {
      if (!wanted.has(id)) {
        physics.removePawnBody(body);
        bodies.delete(id);
      }
    }

    players.length = 0;
    for (const p of s.pawns) {
      let body = bodies.get(p.id);
      if (!body) {
        body = physics.createPawnBody(p.id, p.position.x, p.position.y, p.radius);
        bodies.set(p.id, body);
      }
      physics.setBodyState(body, {
        position: { x: p.position.x, y: p.position.y },
        velocity: { x: p.velocity.x, y: p.velocity.y },
        angle: p.angle,
        angularVelocity: p.angularVelocity,
      });
      // Clean slate; tickSimulation re-derives the pass-over decision.
      physics.setCollidesWithWalls(body, true);
      players.push({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        radius: p.radius,
        spawnX: p.spawnX,
        spawnY: p.spawnY,
        eliminated: p.eliminated,
      });
    }

    turn.phase = s.phase;
    turn.queue = [...s.turn.queue];
    turn.activeIndex = s.turn.activeIndex;
    turn.settleTicks = s.turn.settleTicks;
    aim.active = s.aim.active;
    aim.direction = { ...s.aim.direction };
    power = s.power;
    accumulator = 0;

    emit();
  }

  /** Client-facing projection of the authoritative state. */
  function snapshot(): GameStateSnapshot {
    return projectSnapshot(getState(), LOCAL_PAWN_ID);
  }

  function setPhase(next: GamePhase) {
    turn.phase = next;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Command handling (player intentions)
  // ────────────────────────────────────────────────────────────────────────

  function onAim(x: number, y: number) {
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

  /**
   * Validate and apply a command. Structural validation is total (untrusted
   * input safe); phase gating mirrors the classic engine rules and yields
   * a "wrong-phase" rejection instead of a silent no-op, so a future server
   * can acknowledge commands precisely.
   */
  function applyCommand(command: GameCommand): CommandResult {
    const validation = validateCommand(command);
    if (!validation.ok) return validation;

    switch (command.type) {
      case "aim":
        if (turn.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        onAim(command.x, command.y);
        emit();
        return { ok: true };
      case "setPower":
        if (turn.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        onSetPower(command.power);
        emit();
        return { ok: true };
      case "confirmLaunch":
        if (turn.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        onConfirmLaunch(); // emits on success
        return { ok: true };
      case "reset":
        onReset(); // accepted in every phase; emits
        return { ok: true };
    }
  }

  /** Legacy alias for the client bridge — result discarded. */
  function dispatch(action: GameCommand) {
    applyCommand(action);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Simulation
  // ────────────────────────────────────────────────────────────────────────

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

  return {
    applyCommand,
    dispatch,
    update,
    snapshot,
    getState,
    loadState,
    subscribe,
    destroy,
  };
}
