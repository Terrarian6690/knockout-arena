import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  activePawnId,
  advanceTurn,
  checkSettled,
  createTurnState,
} from "../turnLogic";

/**
 * UPDATED for the N-player model: `advanceTurn` now takes an `isEliminated`
 * predicate and returns the new active pawn id (or null when nobody is left)
 * instead of a wrap flag. Reason: rotation must skip eliminated pawns
 * deterministically while the queue itself stays the full, stable roster.
 */

const NONE_ELIMINATED = () => false;

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

describe("advanceTurn — no eliminations", () => {
  it("wraps a single-pawn queue back to the same pawn", () => {
    const turn = createTurnState(["p0"]);
    expect(advanceTurn(turn, NONE_ELIMINATED)).toBe("p0");
    expect(turn.activeIndex).toBe(0);
    expect(activePawnId(turn)).toBe("p0");
  });

  it("rotates a multi-pawn queue in order and wraps", () => {
    const turn = createTurnState(["a", "b", "c"]);
    expect(advanceTurn(turn, NONE_ELIMINATED)).toBe("b");
    expect(activePawnId(turn)).toBe("b");
    expect(advanceTurn(turn, NONE_ELIMINATED)).toBe("c");
    expect(activePawnId(turn)).toBe("c");
    expect(advanceTurn(turn, NONE_ELIMINATED)).toBe("a"); // wrapped
    expect(activePawnId(turn)).toBe("a");
  });

  it("resets the settle tick counter", () => {
    const turn = createTurnState(["a", "b"]);
    turn.settleTicks = 123;
    advanceTurn(turn, NONE_ELIMINATED);
    expect(turn.settleTicks).toBe(0);
  });
});

describe("advanceTurn — skipping eliminated pawns", () => {
  it("skips a single eliminated pawn", () => {
    const turn = createTurnState(["a", "b", "c"]);
    expect(advanceTurn(turn, (id) => id === "b")).toBe("c");
    expect(activePawnId(turn)).toBe("c");
  });

  it("wraps around the whole roster when intermediate pawns are out", () => {
    const turn = createTurnState(["a", "b", "c"]);
    turn.activeIndex = 2; // c's turn
    // a and b are gone: rotation wraps all the way back to c.
    expect(advanceTurn(turn, (id) => id !== "c")).toBe("c");
    expect(activePawnId(turn)).toBe("c");
  });

  it("handles a run of eliminated pawns in the middle of the queue", () => {
    const turn = createTurnState(["a", "b", "c", "d"]);
    turn.activeIndex = 0;
    expect(advanceTurn(turn, (id) => id === "b" || id === "c")).toBe("d");
    turn.activeIndex = 3;
    expect(advanceTurn(turn, (id) => id === "a" || id === "b" || id === "c")).toBe("d");
  });

  it("returns null when every pawn is eliminated", () => {
    const turn = createTurnState(["a", "b", "c"]);
    expect(advanceTurn(turn, () => true)).toBeNull();
  });

  it("keeps two surviving pawns alternating even when others drop out", () => {
    const turn = createTurnState(["a", "b", "c", "d"]);
    const isOut = (id: string) => id === "a" || id === "d";
    turn.activeIndex = 0;
    expect(advanceTurn(turn, isOut)).toBe("b");
    expect(advanceTurn(turn, isOut)).toBe("c");
    expect(advanceTurn(turn, isOut)).toBe("b"); // wrap, skipping a and d
    expect(advanceTurn(turn, isOut)).toBe("c");
  });

  it("is deterministic for 2/3/4-player rosters with the same flags", () => {
    const run = (ids: string[], out: string[]) => {
      const turn = createTurnState(ids);
      const seq: Array<string | null> = [];
      for (let i = 0; i < ids.length * 2; i++) {
        seq.push(advanceTurn(turn, (id) => out.includes(id)));
      }
      return seq;
    };
    expect(run(["a", "b"], ["a"])).toEqual(["b", "b", "b", "b"]);
    expect(run(["a", "b", "c"], ["b"])).toEqual(["c", "a", "c", "a", "c", "a"]);
    expect(run(["a", "b", "c", "d"], ["b", "d"])).toEqual([
      "c", "a", "c", "a", "c", "a", "c", "a",
    ]);
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
