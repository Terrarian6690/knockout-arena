import { describe, expect, it } from "vitest";
import Matter from "matter-js";
import { CONFIG } from "../config";
import { createArena, floorRadius } from "../arena";
import { createPhysicsWorld } from "../physics";

const DT = CONFIG.simulation.fixedTimestepMs;
const PAWN_R = CONFIG.pawn.radius;
/** Distance of a point from the arena center. */
const dist = (x: number, y: number) =>
  Math.hypot(x - CONFIG.arena.centerX, y - CONFIG.arena.centerY);
/** Phase-1 spawn: just inside the top rim. */
const SPAWN = spawnTop();
function spawnTop(): [number, number] {
  const arena = createArena();
  const r = floorRadius(arena) - PAWN_R - 8;
  return [arena.centerX, arena.centerY - r];
}

describe("createPhysicsWorld", () => {
  it("exposes an arena derived from CONFIG", () => {
    const physics = createPhysicsWorld();
    expect(physics.arena).toEqual(createArena());
    physics.destroy();
  });

  it("disables gravity (top-down view)", () => {
    const physics = createPhysicsWorld();
    expect(physics.engine.world.gravity.x).toBe(0);
    expect(physics.engine.world.gravity.y).toBe(0);
    physics.destroy();
  });

  it("builds the boundary ring of static arenaWall bodies on creation", () => {
    const physics = createPhysicsWorld();
    const walls = physics.engine.world.bodies.filter(
      (b) => b.label === "arenaWall"
    );
    expect(walls.length).toBe(64);
    expect(walls.every((b) => b.isStatic)).toBe(true);
    physics.destroy();
  });
});

describe("pawn bodies", () => {
  it("creates a pawn at the requested position with a pawn:<id> label", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 110, PAWN_R);
    expect(physics.label(body)).toBe("pawn:p0");
    expect(physics.position(body)).toEqual({ x: 450, y: 110 });
    expect(body.isStatic).toBe(false);
    physics.destroy();
  });

  it("adds the pawn to the world", () => {
    const physics = createPhysicsWorld();
    const before = physics.engine.world.bodies.length;
    physics.createPawnBody("p0", 450, 110, PAWN_R);
    expect(physics.engine.world.bodies.length).toBe(before + 1);
    physics.destroy();
  });

  it("removes a pawn from the world", () => {
    const physics = createPhysicsWorld();
    const before = physics.engine.world.bodies.length;
    const body = physics.createPawnBody("p0", 450, 110, PAWN_R);
    physics.removePawnBody(body);
    expect(physics.engine.world.bodies.length).toBe(before);
    physics.destroy();
  });
});

describe("velocity and impulses", () => {
  it("starts pawns at rest", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    expect(physics.velocity(body)).toEqual({ x: 0, y: 0 });
    physics.destroy();
  });

  it("applyImpulse adds Δv directly", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.applyImpulse(body, 2, -1);
    expect(physics.velocity(body).x).toBeCloseTo(2, 9);
    expect(physics.velocity(body).y).toBeCloseTo(-1, 9);
    physics.destroy();
  });

  it("applyImpulse accumulates on the current velocity", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.applyImpulse(body, 1, 0);
    physics.applyImpulse(body, 1.5, 0);
    expect(physics.velocity(body).x).toBeCloseTo(2.5, 9);
    physics.destroy();
  });

  it("stop zeroes the velocity", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.applyImpulse(body, 3, 3);
    physics.stop(body);
    expect(physics.velocity(body)).toEqual({ x: 0, y: 0 });
    physics.destroy();
  });
});

describe("step", () => {
  it("moves a body according to its velocity (fixed delta)", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.applyImpulse(body, 2, 0);
    physics.step(DT);
    const moved = physics.position(body).x - 450;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(2); // frictionAir cannot speed it up
    physics.destroy();
  });

  it("decays speed through air friction (momentum gliding)", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.applyImpulse(body, 3, 0);
    let speed = 3;
    for (let i = 0; i < 30; i++) {
      const v = physics.velocity(body);
      const next = Math.hypot(v.x, v.y);
      expect(next).toBeLessThanOrEqual(speed + 1e-9);
      speed = next;
      physics.step(DT);
    }
    expect(speed).toBeLessThan(2); // visibly slowed by friction
    physics.destroy();
  });
});

describe("rim collisions", () => {
  it("bounces a pawn off the rim when wall collision is enabled", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", SPAWN[0], SPAWN[1], PAWN_R);
    physics.applyImpulse(body, 0, -3.0); // outward (up) at the top rim

    let maxDist = 0;
    let bounced = false;
    for (let i = 0; i < 120; i++) {
      physics.step(DT);
      maxDist = Math.max(maxDist, dist(physics.position(body).x, physics.position(body).y));
      if (physics.velocity(body).y > 0.1) bounced = true; // heading back in
    }
    // Never fully left the floor, and the rim reversed the motion.
    expect(maxDist).toBeLessThan(floorRadius(physics.arena) + PAWN_R);
    expect(bounced).toBe(true);
    physics.destroy();
  });

  it("lets a pawn pass over the rim when wall collision is disabled", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", SPAWN[0], SPAWN[1], PAWN_R);
    physics.setCollidesWithWalls(body, false);
    physics.applyImpulse(body, 0, -3.0);

    let beyond = false;
    for (let i = 0; i < 120; i++) {
      physics.step(DT);
      if (dist(physics.position(body).x, physics.position(body).y) > floorRadius(physics.arena) + PAWN_R) {
        beyond = true;
        break;
      }
    }
    expect(beyond).toBe(true);
    physics.destroy();
  });

  it("restores rim collision after re-enabling", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", SPAWN[0], SPAWN[1], PAWN_R);
    physics.setCollidesWithWalls(body, false);
    physics.setCollidesWithWalls(body, true);
    physics.applyImpulse(body, 0, -3.0);

    let maxDist = 0;
    for (let i = 0; i < 120; i++) {
      physics.step(DT);
      maxDist = Math.max(maxDist, dist(physics.position(body).x, physics.position(body).y));
    }
    expect(maxDist).toBeLessThan(floorRadius(physics.arena) + PAWN_R);
    physics.destroy();
  });
});

describe("onCollision", () => {
  it("reports pawn-on-rim contacts with both bodies", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", SPAWN[0], SPAWN[1], PAWN_R);

    const hits: Array<[string, string]> = [];
    physics.onCollision((a, b) => {
      hits.push([physics.label(a), physics.label(b)].sort() as [string, string]);
    });

    physics.applyImpulse(body, 0, -3.0); // straight into the top rim
    for (let i = 0; i < 30 && hits.length === 0; i++) physics.step(DT);

    expect(hits.length).toBeGreaterThan(0);
    for (const [l1, l2] of hits) {
      expect([l1, l2]).toContain("pawn:p0");
      expect([l1, l2]).toContain("arenaWall");
    }
    physics.destroy();
  });

  it("stays silent while nothing collides", () => {
    const physics = createPhysicsWorld();
    physics.createPawnBody("p0", CONFIG.arena.centerX, CONFIG.arena.centerY, PAWN_R);
    let calls = 0;
    physics.onCollision(() => calls++);
    for (let i = 0; i < 60; i++) physics.step(DT);
    expect(calls).toBe(0);
    physics.destroy();
  });
});

describe("destroy", () => {
  it("clears the world without throwing", () => {
    const physics = createPhysicsWorld();
    physics.createPawnBody("p0", 450, 110, PAWN_R);
    expect(() => physics.destroy()).not.toThrow();
    expect(physics.engine.world.bodies.length).toBe(0);
  });

  it("removes engine event listeners (no callbacks after teardown)", () => {
    const physics = createPhysicsWorld();
    physics.createPawnBody("p0", SPAWN[0], SPAWN[1], PAWN_R);
    let calls = 0;
    physics.onCollision(() => calls++);
    physics.destroy();

    // Simulate a late engine update: the listener must not fire anymore.
    Matter.Engine.update(physics.engine, DT);
    expect(calls).toBe(0);
  });
});
