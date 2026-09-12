import Matter from "matter-js";
import { CONFIG } from "./config";
import { createArena, floorRadius, type Arena } from "./arena";
import type { Vec2 } from "./types";

const { Engine, Bodies, Composite, Body, Events } = Matter;

/**
 * Collision category bits. There is exactly one: pawns collide with each
 * other and nothing else — the arena has NO physical wall (no ring bodies
 * exist in the world at all), so outward launches always leave the floor
 * and elimination is decided purely by geometry (see arena.ts).
 */
const CAT_PAWN = 0x0001;

/**
 * Plain-data kinematics of a physics body. This is the ONLY shape from the
 * physics layer that ever leaves the engine as state — deliberately free of
 * Matter.js types so GameState stays serializable.
 */
export interface BodyKinematics {
  position: Vec2;
  velocity: Vec2;
  angle: number;
  angularVelocity: number;
}

/**
 * Physics module — the only place that knows about Matter.js.
 *
 * Responsibilities:
 *  - own the Matter engine + world (pawn bodies ONLY — no boundary walls)
 *  - create pawn bodies that collide with each other
 *  - step the simulation and expose a clean query interface
 *
 * The rest of the code (game.ts, turnLogic.ts) talks to this module through a
 * narrow facade so we can later swap the physics backend without touching the
 * game logic.
 */
export interface PhysicsWorld {
  engine: Matter.Engine;
  arena: Arena;
  /** Create a circular pawn body (collides with other pawns only). */
  createPawnBody(id: string, x: number, y: number, radius: number): Matter.Body;
  /** Remove a pawn body from the world. */
  removePawnBody(body: Matter.Body): void;
  /** Advance the physics by one FIXED timestep (supplied by the game loop). */
  step(dtMs: number): void;
  /** Apply a velocity impulse (direct Δv) to a body. */
  applyImpulse(body: Matter.Body, ix: number, iy: number): void;
  /** Read a body's center position. */
  position(body: Matter.Body): { x: number; y: number };
  /** Read a body's velocity. */
  velocity(body: Matter.Body): { x: number; y: number };
  /** The body's configured label (e.g. "pawn:p0"). */
  label(body: Matter.Body): string;
  /** Stop a body in place. */
  stop(body: Matter.Body): void;
  /**
   * Read a body's kinematics (position, velocity, angle, angular velocity)
   * as plain data — used to build the serializable GameState without
   * exposing Matter internals.
   */
  bodyState(body: Matter.Body): BodyKinematics;
  /**
   * Restore a body's kinematics from plain data (counterpart of bodyState).
   * Uses Matter's official setters so the engine's internal bookkeeping
   * (positionPrev etc.) stays consistent.
   */
  setBodyState(body: Matter.Body, state: BodyKinematics): void;
  /**
   * Toggle whether a body participates in ANY collision. Used to make an
   * eliminated pawn a non-collidable "ghost": it stays in the world (frozen,
   * still rendered where it left the arena) but neither blocks nor is pushed
   * by the remaining pawns. Restored by reset/loadState.
   */
  setGhost(body: Matter.Body, ghosted: boolean): void;
  /**
   * Bring a pawn to its canonical resting state at the end of a turn: stop
   * it (velocity + solver buffers zeroed) and, if its center ended up past
   * the floor edge, project it back onto the floor. A settled pawn therefore
   * never rests straddling the logical boundary — which is what makes
   * "settled" a deterministic, serializable state boundary (Matter's
   * warm-started contact corrections would otherwise keep nudging the body
   * microscopically on every later step, invisibly in velocity but
   * differently between a live engine and a reconstructed one).
   */
  settleOnFloor(body: Matter.Body, pawnRadius: number): void;
  /** Subscribe to collision events (fires for each colliding pair). */
  onCollision(cb: (a: Matter.Body, b: Matter.Body) => void): void;
  /** Tear down the world and remove all engine event listeners. */
  destroy(): void;
}

export function createPhysicsWorld(): PhysicsWorld {
  const engine = Engine.create({ enableSleeping: false });
  const arena = createArena();

  // Top-down view: no gravity. Prevent sleeping so we keep full control over
  // settle logic.
  engine.world.gravity.x = 0;
  engine.world.gravity.y = 0;

  const world = engine.world;

  // NOTE: no boundary bodies are ever built. The arena has no physical
  // wall — pawns glide straight off the floor and elimination is decided
  // purely by geometry (see arena.ts). Nothing invisible takes the wall's
  // place: the world's only colliders are the pawns themselves.

  function createPawnBody(
    id: string,
    x: number,
    y: number,
    radius: number
  ): Matter.Body {
    const body = Bodies.circle(x, y, radius, {
      label: `pawn:${id}`,
      density: CONFIG.pawn.density,
      friction: CONFIG.pawn.friction,
      frictionAir: CONFIG.pawn.frictionAir,
      frictionStatic: CONFIG.pawn.frictionStatic,
      restitution: CONFIG.pawn.restitution,
      // Pawns collide with other pawns only — there is no rim to hit.
      collisionFilter: { category: CAT_PAWN, mask: CAT_PAWN },
    });
    Composite.add(world, body);
    return body;
  }

  function removePawnBody(body: Matter.Body) {
    Composite.remove(world, body);
  }

  function step(dtMs: number) {
    // dtMs must be the FIXED timestep supplied by the game loop (see
    // game.ts): Matter integrates deterministically as long as every update
    // is called with the same delta.
    Engine.update(engine, dtMs);
  }

  function applyImpulse(body: Matter.Body, ix: number, iy: number) {
    // Direct velocity impulse: add Δv to the current velocity. This is the
    // deterministic "launch" effect (mass is irrelevant for equal-mass pawns,
    // and collisions still respect mass for knockback resolution later).
    Body.setVelocity(body, {
      x: body.velocity.x + ix,
      y: body.velocity.y + iy,
    });
    Body.setAngularVelocity(body, 0);
  }

  function position(body: Matter.Body) {
    return { x: body.position.x, y: body.position.y };
  }

  function velocity(body: Matter.Body) {
    return { x: body.velocity.x, y: body.velocity.y };
  }

  function label(body: Matter.Body) {
    return body.label ?? "";
  }

  function stop(body: Matter.Body) {
    Body.setVelocity(body, { x: 0, y: 0 });
    Body.setAngularVelocity(body, 0);
    clearSolverBuffers(body);
  }

  /**
   * Zero Matter's warm-start correction buffers on a body.
   *
   * Matter caches positional corrections from previous collision steps
   * (`positionImpulse`, `constraintImpulse`) and re-applies them on every
   * Engine.update — moving the body's position (and positionPrev, so the
   * reported velocity stays 0). A body that was "stopped" mid-contact would
   * therefore keep creeping microscopically forever, and a RECONSTRUCTED
   * body (fresh buffers) would diverge from the original one that still
   * carries the cache — breaking deterministic state transfer.
   *
   * Clearing the buffers at the semantic "this body is now at rest / inert"
   * points (stop, ghosting) makes those points clean serialization
   * boundaries: both a live engine and a reconstructed one restart the
   * contact solver from scratch, so they stay bit-identical.
   */
  function clearSolverBuffers(body: Matter.Body) {
    const buffered = body as Matter.Body & {
      positionImpulse: { x: number; y: number };
      constraintImpulse: { x: number; y: number; angle: number };
    };
    buffered.positionImpulse.x = 0;
    buffered.positionImpulse.y = 0;
    buffered.constraintImpulse.x = 0;
    buffered.constraintImpulse.y = 0;
    buffered.constraintImpulse.angle = 0;
  }

  function bodyState(body: Matter.Body): BodyKinematics {
    return {
      position: { x: body.position.x, y: body.position.y },
      velocity: { x: body.velocity.x, y: body.velocity.y },
      angle: body.angle,
      angularVelocity: body.angularVelocity,
    };
  }

  function setBodyState(body: Matter.Body, state: BodyKinematics) {
    Body.setPosition(body, { x: state.position.x, y: state.position.y });
    Body.setVelocity(body, { x: state.velocity.x, y: state.velocity.y });
    Body.setAngle(body, state.angle);
    Body.setAngularVelocity(body, state.angularVelocity);
  }

  function setGhost(body: Matter.Body, ghosted: boolean) {
    body.collisionFilter.mask = ghosted ? 0 : CAT_PAWN;
    if (ghosted) {
      // A ghost must be truly frozen: drop any cached collision corrections
      // (see clearSolverBuffers) so nothing nudges it after elimination.
      clearSolverBuffers(body);
    }
  }

  function settleOnFloor(body: Matter.Body, pawnRadius: number) {
    // A settled pawn rests fully on the floor with a 1-unit deterministic
    // margin inside the logical edge — never straddling the boundary.
    const contactDist = floorRadius(arena) - pawnRadius - 1;
    const dx = body.position.x - arena.centerX;
    const dy = body.position.y - arena.centerY;
    const dist = Math.hypot(dx, dy);
    if (dist > contactDist) {
      const scale = contactDist / dist;
      Body.setPosition(body, {
        x: arena.centerX + dx * scale,
        y: arena.centerY + dy * scale,
      });
    }
    stop(body);
  }

  // Keep a reference to the collision listener so destroy() can remove it.
  let collisionHandler: ((event: Matter.IEventCollision<Matter.Engine>) => void) | null = null;

  function onCollision(cb: (a: Matter.Body, b: Matter.Body) => void) {
    collisionHandler = (event: Matter.IEventCollision<Matter.Engine>) => {
      for (const pair of event.pairs) {
        cb(pair.bodyA, pair.bodyB);
      }
    };
    Events.on(engine, "collisionStart", collisionHandler);
  }

  function destroy() {
    // Remove the collision listener first so teardown does not fire it.
    if (collisionHandler) {
      Events.off(engine, "collisionStart", collisionHandler);
      collisionHandler = null;
    }
    Composite.clear(world, false, true);
    Engine.clear(engine);
  }

  return {
    engine,
    arena,
    createPawnBody,
    removePawnBody,
    step,
    applyImpulse,
    position,
    velocity,
    label,
    stop,
    bodyState,
    setBodyState,
    setGhost,
    settleOnFloor,
    onCollision,
    destroy,
  };
}
