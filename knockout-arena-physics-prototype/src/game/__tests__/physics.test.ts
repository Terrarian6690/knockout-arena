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

  it("builds NO boundary ring — the world holds pawns only, no walls", () => {
    const physics = createPhysicsWorld();
    // No static bodies at all (neither a visible ring nor an invisible
    // replacement collider): the launch space is completely open.
    expect(physics.engine.world.bodies).toHaveLength(0);
    physics.createPawnBody("p0", 450, 350, PAWN_R);
    const bodies = physics.engine.world.bodies;
    expect(bodies).toHaveLength(1);
    expect(bodies[0].label).toBe("pawn:p0");
    expect(bodies[0].isStatic).toBe(false);
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

describe("no outer wall", () => {
  it("an outward launch crosses the floor edge unimpeded (nothing bounces it back)", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", SPAWN[0], SPAWN[1], PAWN_R);
    physics.applyImpulse(body, 0, -3.0); // outward (up) from the top spawn

    let beyond = false;
    for (let i = 0; i < 120; i++) {
      physics.step(DT);
      // The motion is never reversed: no bounce exists anymore.
      expect(physics.velocity(body).y).toBeLessThanOrEqual(0.1);
      if (dist(physics.position(body).x, physics.position(body).y) > floorRadius(physics.arena) + PAWN_R) {
        beyond = true;
        break;
      }
    }
    expect(beyond).toBe(true);
    physics.destroy();
  });

  it("even a gentle launch at the edge leaves — no minimum clearing speed", () => {
    const physics = createPhysicsWorld();
    // Start exactly at the floor edge, drifting outward slowly: with no
    // wall there is no threshold to beat, so even this nudge exits.
    const edgeY = CONFIG.arena.centerY - floorRadius(physics.arena);
    const body = physics.createPawnBody("p0", CONFIG.arena.centerX, edgeY, PAWN_R);
    physics.applyImpulse(body, 0, -0.5);

    let beyond = false;
    for (let i = 0; i < 120; i++) {
      physics.step(DT);
      expect(physics.velocity(body).y).toBeLessThanOrEqual(0.1);
      if (dist(physics.position(body).x, physics.position(body).y) > floorRadius(physics.arena) + PAWN_R) {
        beyond = true;
        break;
      }
    }
    expect(beyond).toBe(true);
    physics.destroy();
  });

  it("pawns still collide with each other (pawn-vs-pawn contact works)", () => {
    const physics = createPhysicsWorld();
    const mover = physics.createPawnBody("mover", 450, 300, PAWN_R);
    physics.createPawnBody("target", 450, 350, PAWN_R);
    physics.applyImpulse(mover, 0, 2.5); // straight into the target

    for (let i = 0; i < 60; i++) physics.step(DT);

    // The target was shoved well out of its starting spot by the impact.
    const target = physics.engine.world.bodies.find(
      (b) => physics.label(b) === "pawn:target"
    )!;
    expect(physics.position(target).y).toBeGreaterThan(350 + 5);
    physics.destroy();
  });
});

describe("ghosts and canonical rest (N-player support)", () => {
  it("setGhost removes the body from ALL collisions; un-ghosting restores them", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.setGhost(body, true);
    expect(body.collisionFilter.mask).toBe(0);
    physics.setGhost(body, false);
    expect(body.collisionFilter.mask).toBe(0x0001); // pawns only — no wall bit
    physics.destroy();
  });

  it("a ghost does not collide with anything while another pawn sweeps past it", () => {
    const physics = createPhysicsWorld();
    const mover = physics.createPawnBody("mover", 450, 300, PAWN_R);
    const ghost = physics.createPawnBody("ghost", 450, 350, PAWN_R);
    physics.setGhost(ghost, true);

    physics.applyImpulse(mover, 0, 2.5); // straight through the ghost's spot
    let passedThrough = false;
    for (let i = 0; i < 60; i++) {
      physics.step(DT);
      const p = physics.position(mover);
      if (p.y > 350) passedThrough = true; // mover crossed the ghost's center
      expect(physics.velocity(mover).y).toBeGreaterThan(0.5); // unimpeded
    }
    expect(passedThrough).toBe(true);
    // The ghost never moved.
    expect(physics.position(ghost)).toEqual({ x: 450, y: 350 });
    physics.destroy();
  });

  it("settleOnFloor stops the body and clears Matter's warm-start buffers", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.applyImpulse(body, 3, 0);
    physics.settleOnFloor(body, PAWN_R);
    expect(physics.velocity(body)).toEqual({ x: 0, y: 0 });
    // A moving body's cached positional corrections must not survive a stop
    // (they would keep nudging the "stopped" body on every later step).
    const buffered = body as Matter.Body & {
      positionImpulse: { x: number; y: number };
    };
    expect(buffered.positionImpulse).toEqual({ x: 0, y: 0 });
    physics.destroy();
  });

  it("settleOnFloor projects a rim-penetrating pawn back onto the floor", () => {
    const physics = createPhysicsWorld();
    // End the turn slightly inside the rim (a leftover penetration from the
    // contact solver): center at floorRadius - radius + 0.2.
    const y = CONFIG.arena.centerY + floorRadius(physics.arena) - PAWN_R + 0.2;
    const body = physics.createPawnBody("p0", CONFIG.arena.centerX, y, PAWN_R);
    physics.settleOnFloor(body, PAWN_R);
    const d = dist(physics.position(body).x, physics.position(body).y);
    expect(d).toBeLessThanOrEqual(floorRadius(physics.arena) - PAWN_R - 1 + 1e-9);
    physics.destroy();
  });

  it("settleOnFloor leaves pawns that rest fully inside the floor untouched", () => {
    const physics = createPhysicsWorld();
    const body = physics.createPawnBody("p0", 450, 350, PAWN_R);
    physics.settleOnFloor(body, PAWN_R);
    expect(physics.position(body)).toEqual({ x: 450, y: 350 });
    physics.destroy();
  });

  it("a settled pawn resting on the floor stays exactly frozen while others fly", () => {
    const physics = createPhysicsWorld();
    // Pawn resting just inside the floor edge (nothing to touch out there
    // → no contact pair → no solver nudging on later steps).
    const y = CONFIG.arena.centerY + floorRadius(physics.arena) - PAWN_R - 1;
    const resting = physics.createPawnBody("rest", CONFIG.arena.centerX, y, PAWN_R);
    physics.settleOnFloor(resting, PAWN_R);
    const other = physics.createPawnBody("other", 450, 150, PAWN_R);
    physics.applyImpulse(other, 0, 0.9); // an unrelated flight elsewhere

    for (let i = 0; i < 120; i++) {
      physics.step(DT);
      expect(physics.position(resting)).toEqual({ x: CONFIG.arena.centerX, y });
    }
    physics.destroy();
  });
});

describe("onCollision", () => {
  it("reports pawn-vs-pawn contacts with both bodies (and never a wall)", () => {
    const physics = createPhysicsWorld();
    const mover = physics.createPawnBody("mover", 450, 300, PAWN_R);
    physics.createPawnBody("target", 450, 350, PAWN_R);

    const hits: Array<[string, string]> = [];
    physics.onCollision((a, b) => {
      hits.push([physics.label(a), physics.label(b)].sort() as [string, string]);
    });

    physics.applyImpulse(mover, 0, 2.5); // straight into the other pawn
    for (let i = 0; i < 60 && hits.length === 0; i++) physics.step(DT);

    expect(hits.length).toBeGreaterThan(0);
    for (const [l1, l2] of hits) {
      expect([l1, l2]).toContain("pawn:mover");
      expect([l1, l2]).toContain("pawn:target");
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
