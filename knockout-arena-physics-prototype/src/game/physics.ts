import Matter from "matter-js";
import { CONFIG } from "./config";
import { createArena, floorRadius, type Arena } from "./arena";

const { Engine, Bodies, Composite, Body, Events } = Matter;

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
  /** Advance the physics by one fixed step. */
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
  /** Subscribe to collision events (fires for each colliding pair). */
  onCollision(cb: (a: Matter.Body, b: Matter.Body) => void): void;
}

export function createPhysicsWorld(): PhysicsWorld {
  const engine = Engine.create({ enableSleeping: false });
  const arena = createArena();

  // Prevent any body from sleeping so we keep full control over settle logic.
  engine.world.gravity.x = 0;
  engine.world.gravity.y = 0;

  const world = engine.world as any;

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
    });
    Composite.add(world, body);
    return body;
  }

  function removePawnBody(body: Matter.Body) {
    Composite.remove(world, body);
  }

  function step(dtMs: number) {
    // fixed timestep for deterministic-ish behavior
    Engine.update(engine, Math.min(dtMs, 34));
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

  function onCollision(cb: (a: Matter.Body, b: Matter.Body) => void) {
    Events.on(engine, "collisionStart", (event: Matter.IEventCollision<Matter.Engine>) => {
      for (const pair of event.pairs) {
        cb(pair.bodyA, pair.bodyB);
      }
    });
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
    onCollision,
  };
}
