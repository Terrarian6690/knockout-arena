import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  activePawnId,
  advanceTurn,
  checkSettled,
  createTurnState,
} from "../turnLogic";

describe("createTurnState", () => {
  it("starts a single-pawn match in the aiming phase", () => {
    const turn = createTurnState(["p0"]);
    expect(turn.phase).toBe("aiming");
    expect(turn.queue).toEqual(["p0"]);
    expect(turn.activeIndex).toBe(0);
    expect(turn.settleTicks).toBe(0);
  });

  it("preserves the turn order queue", () => {
    const turn = createTurnState(["a", "b", "c"]);
    expect(turn.queue).toEqual(["a", "b", "c"]);
  });
});

describe("activePawnId", () => {
  it("returns the pawn at the active index", () => {
    const turn = createTurnState(["a", "b", "c"]);
    expect(activePawnId(turn)).toBe("a");
    turn.activeIndex = 2;
    expect(activePawnId(turn)).toBe("c");
  });

  it("returns null for an empty queue", () => {
    expect(activePawnId(createTurnState([]))).toBeNull();
  });
});

describe("advanceTurn", () => {
  it("wraps a single-pawn queue and reports the wrap", () => {
    const turn = createTurnState(["p0"]);
    expect(advanceTurn(turn)).toBe(true);
    expect(turn.activeIndex).toBe(0);
    expect(activePawnId(turn)).toBe("p0");
  });

  it("rotates a multi-pawn queue in order", () => {
    const turn = createTurnState(["a", "b", "c"]);
    expect(advanceTurn(turn)).toBe(false);
    expect(activePawnId(turn)).toBe("b");
    expect(advanceTurn(turn)).toBe(false);
    expect(activePawnId(turn)).toBe("c");
    expect(advanceTurn(turn)).toBe(true);
    expect(activePawnId(turn)).toBe("a");
  });

  it("resets the settle tick counter", () => {
    const turn = createTurnState(["a", "b"]);
    turn.settleTicks = 123;
    advanceTurn(turn);
    expect(turn.settleTicks).toBe(0);
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
