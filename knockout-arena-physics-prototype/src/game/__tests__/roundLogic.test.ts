import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { checkSettled, createRoundState } from "../roundLogic";

/**
 * UPDATED for the simultaneous-round model: the turn module is gone — there
 * is no queue, no active index and no rotation. The round state is just the
 * shared phase plus the settle counter used to resolve the movement phase.
 */

describe("createRoundState", () => {
  it("starts a match in the aiming phase", () => {
    const round = createRoundState();
    expect(round.phase).toBe("aiming");
    expect(round.settleTicks).toBe(0);
  });

  it("is independent per match (no shared mutable state)", () => {
    const a = createRoundState();
    const b = createRoundState();
    a.settleTicks = 42;
    a.phase = "moving";
    expect(b.settleTicks).toBe(0);
    expect(b.phase).toBe("aiming");
  });
});

describe("checkSettled", () => {
  it("settles when the speed drops below the rest threshold", () => {
    const r = checkSettled(CONFIG.simulation.restSpeedThreshold / 2, 10);
    expect(r.settled).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("does not settle while the pawn is fast", () => {
    const r = checkSettled(5, 10);
    expect(r.settled).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it("treats the threshold as strictly-below", () => {
    const r = checkSettled(CONFIG.simulation.restSpeedThreshold, 10);
    expect(r.settled).toBe(false);
  });

  it("force-settles (timeout) after the maximum settle ticks", () => {
    const r = checkSettled(5, CONFIG.simulation.maxSettleTicks);
    expect(r.settled).toBe(true);
    expect(r.timedOut).toBe(true);
  });

  it("does not time out before the maximum settle ticks", () => {
    const r = checkSettled(5, CONFIG.simulation.maxSettleTicks - 1);
    expect(r.settled).toBe(false);
    expect(r.timedOut).toBe(false);
  });
});
