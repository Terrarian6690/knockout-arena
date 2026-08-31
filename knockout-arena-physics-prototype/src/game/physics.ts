import Matter from "matter-js";
import { CONFIG } from "./config";
import { createArena, floorRadius, type Arena } from "./arena";
import type { Vec2 } from "./types";

const { Engine, Bodies, Composite, Body, Events } = Matter;

/** Collision category bits: pawns and the arena rim. */
const CAT_PAWN = 0x0001;
const CAT_WALL = 0x0002;

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
 *  - own the Matter engine + world
 *  - create pawn bodies and the arena boundary walls
 *  - step the simulation and expose a clean query interface
 *
 * The rest of the code (game.ts, turnLogic.ts) talks to this module through a
 * narrow facade so we can later swap the physics backend without touching the
 * game logic.
 */
export interface PhysicsWorld {
  engine: Matter.Engine;
  arena: Arena;
  /** Create a circular pawn body. */
  createPawnBody(id: string, x: number, y: number, radius: number): Matter.Body;
  /** Remove a pawn body from the world. */
  removePawnBody(body: Matter.Body): void;
  /** Rebuild boundary walls (called once on init or after resize). */
  buildBoundary(): void;
  /** Advance the physics by one FIXED timestep (supplied by the game loop). */
  step(dtMs: number): void;
  /** Apply a velocity impulse (direct Δv) to a body. */
  applyImpulse(body: Matter.Body, ix: number, iy: number): void;
  /** Read a body's center position. */
  position(body: Matter.Body): { x: number; y: number };
  /** Read a body's velocity. */
  velocity(body: Matter.Body): { x: number; y: number };
  /** The body's configured label (e.g. "pawn:p0", "arenaWall"). */
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
   * Toggle whether a body collides with the arena rim. Used for the rim
   * pass-over rule: a fast head-on contact clears the lip and stops
   * colliding with it so the pawn can leave the floor.
   */
  setCollidesWithWalls(body: Matter.Body, enabled: boolean): void;
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

  // Keep a reference to boundary pieces so we can rebuild them.
  let boundaryBodies: Matter.Body[] = [];

  function buildBoundary() {
    // Remove any previous boundary pieces.
    for (const b of boundaryBodies) {
      Composite.remove(world, b);
    }
    boundaryBodies = [];

    const r = floorRadius(arena);
    const wall = arena.wallThickness;
    const cx = arena.centerX;
    const cy = arena.centerY;

    // Build an inner circle of static segments approximating the boundary.
    // The number of segments balances smoothness against cost.
    const segments = 64;
    const ringRadius = r + wall / 2 - 1;

    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0 = {
        x: cx + Math.cos(a0) * ringRadius,
        y: cy + Math.sin(a0) * ringRadius,
      };
      const p1 = {
        x: cx + Math.cos(a1) * ringRadius,
        y: cy + Math.sin(a1) * ringRadius,
      };
      const segment = Bodies.rectangle(
        (p0.x + p1.x) / 2,
        (p0.y + p1.y) / 2,
        Math.hypot(p1.x - p0.x, p1.y - p0.y) + wall * 0.6,
        wall,
        {
          isStatic: true,
          angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
          friction: 0.01,
          restitution: CONFIG.pawn.restitution,
          label: "arenaWall",
          collisionFilter: { category: CAT_WALL, mask: CAT_PAWN },
        }
      );
      boundaryBodies.push(segment);
    }

    Composite.add(world, boundaryBodies);
  }

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
      // Pawns collide with other pawns and with the rim; the rim can be
      // toggled off per-pawn for the pass-over rule (see setCollidesWithWalls).
      collisionFilter: { category: CAT_PAWN, mask: CAT_PAWN | CAT_WALL },
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

  function setCollidesWithWalls(body: Matter.Body, enabled: boolean) {
    body.collisionFilter.mask = enabled
      ? CAT_PAWN | CAT_WALL
      : CAT_PAWN;
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

  // Build the initial boundary.
  buildBoundary();

  return {
    engine,
    arena,
    createPawnBody,
    removePawnBody,
    buildBoundary,
    step,
    applyImpulse,
    position,
    velocity,
    label,
    stop,
    bodyState,
    setBodyState,
    setCollidesWithWalls,
    onCollision,
    destroy,
  };
}
