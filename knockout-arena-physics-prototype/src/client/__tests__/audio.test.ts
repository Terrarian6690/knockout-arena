import { describe, expect, it } from "vitest";
import { AudioManager, MAX_ACTIVE_SOUNDS, type AudioContextLike } from "../audio";
import type { VfxEvent } from "../effects";

/**
 * The client-side audio manager — everything mocked (no real Web Audio,
 * no speakers): settings (volume/mute/clamping), the distinct synthesized
 * sounds, launch coalescing, the active-sound bound with node cleanup,
 * lazy single-context creation, autoplay semantics (suspended context,
 * no context at all), envelope shape (no clicks), and persistence.
 * Labels follow the Task 22 spec.
 */

// ── A structural mock of the Web Audio API the manager uses. ──────────
class MockParam {
  calls: string[] = [];
  value = 0;
  setValueAtTime(v: number, t: number) {
    this.calls.push(`set@${t.toFixed(3)}:${v.toFixed(3)}`);
    this.value = v;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(`linear@${t.toFixed(3)}:${v.toFixed(3)}`);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(`exp@${t.toFixed(3)}:${v.toFixed(3)}`);
  }
}

class MockNode {
  connectedTo: MockNode[] = [];
  disconnectCalled = false;
  connect(node: MockNode) {
    this.connectedTo.push(node);
    return node;
  }
  disconnect() {
    this.disconnectCalled = true;
  }
}

class MockOsc extends MockNode {
  type = "";
  frequency = new MockParam();
  startedAt: number[] = [];
  stoppedAt: number[] = [];
  onended: (() => void) | null = null;
  start(when = 0) {
    this.startedAt.push(when);
  }
  stop(when: number) {
    this.stoppedAt.push(when);
  }
}

class MockGain extends MockNode {
  gain = new MockParam();
}

class MockFilter extends MockNode {
  type = "";
  frequency = new MockParam();
}

class MockContext {
  state: string = "running";
  currentTime = 0;
  destination = new MockNode();
  oscillators: MockOsc[] = [];
  gains: MockGain[] = [];
  filters: MockFilter[] = [];
  createOscillator() {
    const osc = new MockOsc();
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }
  createBiquadFilter() {
    const filter = new MockFilter();
    this.filters.push(filter);
    return filter;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
}

/** A manager over a fresh mock context (+ factory call counting). */
function makeManager() {
  let factoryCalls = 0;
  const ctx = new MockContext();
  const manager = new AudioManager({
    contextFactory: () => {
      factoryCalls += 1;
      return ctx as unknown as AudioContextLike;
    },
    storage: null,
  });
  return { manager, ctx, factoryCalls: () => factoryCalls };
}

const ELIMINATION: VfxEvent[] = [{ type: "elimination" }];
const ROUND_START: VfxEvent[] = [{ type: "round-start" }];
const WINNER: VfxEvent[] = [{ type: "winner" }];

describe("audio settings", () => {
  it("defaults to enabled at a moderate volume", () => {
    const { manager } = makeManager();
    expect(manager.getSettings()).toEqual({ muted: false, volume: 0.7 });
  });

  it("clamps the master volume into [0, 1]", () => {
    const { manager } = makeManager();
    manager.setVolume(1.7);
    expect(manager.getVolume()).toBe(1);
    manager.setVolume(-0.4);
    expect(manager.getVolume()).toBe(0);
    manager.setVolume(Number.NaN);
    expect(manager.getVolume()).toBe(0);
    manager.setVolume(0.5);
    expect(manager.getVolume()).toBe(0.5);
  });

  it("applies the master volume through the persistent gain node", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.play(ELIMINATION);
    const master = ctx.gains[0]!;
    expect(master.gain.value).toBe(0.7);
    manager.setVolume(0.3);
    expect(master.gain.value).toBe(0.3);
    manager.setMuted(true);
    expect(master.gain.value).toBe(0); // muted = gain 0, node alive
    manager.setMuted(false);
    expect(master.gain.value).toBe(0.3);
  });

  it("muted plays nothing, unmutes cleanly", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.setMuted(true);
    manager.play(ELIMINATION);
    expect(ctx.oscillators).toHaveLength(0);
    manager.setMuted(false);
    manager.play(ELIMINATION);
    expect(ctx.oscillators).toHaveLength(1);
  });

  it("volume zero schedules nothing but never destroys the system", () => {
    const { manager, ctx, factoryCalls } = makeManager();
    manager.unlock();
    const before = factoryCalls();
    manager.setVolume(0);
    manager.play(WINNER);
    expect(ctx.oscillators).toHaveLength(0);
    expect(factoryCalls()).toBe(before); // no new context churn
    manager.setVolume(0.5);
    manager.play(WINNER);
    expect(ctx.oscillators).toHaveLength(3); // alive and playing again
    expect(factoryCalls()).toBe(before); // still the ONE context
  });
});

describe("event playback", () => {
  it("plays a distinct sound per event type", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();

    manager.play(ROUND_START);
    const blip = ctx.oscillators[0]!;
    expect(blip.type).toBe("sine");
    expect(blip.frequency.value).toBe(523);

    manager.play(ELIMINATION);
    const elim = ctx.oscillators[1]!;
    expect(elim.type).toBe("sawtooth");
    expect(ctx.filters).toHaveLength(1); // lowpass on the elimination sweep

    manager.play([{ type: "impact", strength: 2 }]);
    const impact = ctx.oscillators[2]!;
    expect(impact.type).toBe("triangle");

    manager.play([{ type: "launch", power: 5 }]);
    const launch = ctx.oscillators[3]!;
    expect(launch.type).toBe("sawtooth");
    expect(launch.frequency.value).toBeCloseTo(125, 5); // 200 - 5*15
  });

  it("varies the launch sound with power (low = soft, high = stronger)", () => {
    const soft = makeManager();
    soft.manager.unlock();
    soft.manager.play([{ type: "launch", power: 1 }]);
    const hard = makeManager();
    hard.manager.unlock();
    hard.manager.play([{ type: "launch", power: 5 }]);
    const softGain = soft.ctx.gains[1]!; // [0] is the master
    const hardGain = hard.ctx.gains[1]!;
    expect(hardGain.gain.calls[1]).toBeDefined();
    const softPeak = Number(softGain.gain.calls[1]!.split(":")[1]);
    const hardPeak = Number(hardGain.gain.calls[1]!.split(":")[1]);
    expect(hardPeak).toBeGreaterThan(softPeak);
    expect(soft.ctx.oscillators[0]!.frequency.value).toBeGreaterThan(
      hard.ctx.oscillators[0]!.frequency.value
    ); // stronger launches are LOWER
  });

  it("coalesces simultaneous launches into one whoosh at the max power", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.play([
      { type: "launch", power: 2 },
      { type: "launch", power: 4 },
      { type: "round-start" },
    ]);
    const saws = ctx.oscillators.filter((o) => o.type === "sawtooth");
    expect(saws).toHaveLength(1); // ONE launch sound, not a stack
    expect(saws[0]!.frequency.value).toBeCloseTo(200 - 4 * 15, 5); // max power
    expect(ctx.oscillators.some((o) => o.type === "sine")).toBe(true); // + the blip
  });

  it("plays the winner as a short ascending arpeggio (≤ 800 ms)", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.play(WINNER);
    expect(ctx.oscillators).toHaveLength(3);
    expect(ctx.oscillators.map((o) => o.startedAt[0])).toEqual([0, 0.13, 0.26]);
    const lastStop = Math.max(...ctx.oscillators.map((o) => o.stoppedAt[0]!));
    expect(lastStop).toBeLessThanOrEqual(0.8);
  });

  it("uses a click-free envelope on every tone", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.play(ROUND_START);
    const gain = ctx.gains[1]!;
    // From silence (linear attack) to silence (exponential decay).
    expect(gain.gain.calls.some((c) => c.startsWith("linear@"))).toBe(true);
    expect(gain.gain.calls.some((c) => c.startsWith("exp@"))).toBe(true);
    expect(gain.gain.calls.some((c) => c.endsWith(":0.000"))).toBe(true); // starts at 0
  });

  it("ignores empty event batches", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.play([]);
    expect(ctx.oscillators).toHaveLength(0);
  });
});

describe("performance safeguards", () => {
  it("bounds the number of simultaneously scheduled sounds", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    const many: VfxEvent[] = Array.from({ length: 20 }, () => ({
      type: "elimination",
    }));
    manager.play(many);
    expect(ctx.oscillators).toHaveLength(MAX_ACTIVE_SOUNDS);
    expect(manager.activeSounds).toBe(MAX_ACTIVE_SOUNDS);
  });

  it("frees capacity when sounds end (nodes disconnected)", () => {
    const { manager, ctx } = makeManager();
    manager.unlock();
    manager.play(ELIMINATION);
    const osc = ctx.oscillators[0]!;
    const gain = ctx.gains[1]!;
    expect(osc.onended).not.toBeNull();
    osc.onended!();
    expect(manager.activeSounds).toBe(0);
    expect(osc.disconnectCalled).toBe(true);
    expect(gain.disconnectCalled).toBe(true);
    // Capacity freed: the next sound plays.
    manager.play(ELIMINATION);
    expect(ctx.oscillators).toHaveLength(2);
  });

  it("creates exactly one AudioContext, lazily", () => {
    const { manager, ctx, factoryCalls } = makeManager();
    expect(factoryCalls()).toBe(0); // nothing before it is needed
    manager.unlock();
    expect(factoryCalls()).toBe(1);
    manager.play(WINNER);
    manager.play(ELIMINATION);
    manager.unlock();
    expect(factoryCalls()).toBe(1); // never one per sound
    expect(ctx.gains[0]!.connectedTo).toContain(ctx.destination); // master wired once
  });
});

describe("autoplay and environment safety", () => {
  it("silently skips sounds while the context is suspended", () => {
    const { manager, ctx } = makeManager();
    ctx.state = "suspended";
    manager.play(ELIMINATION);
    expect(ctx.oscillators).toHaveLength(0); // no throw, no sound
    // A user gesture resumes it; from then on sounds play.
    manager.unlock();
    expect(ctx.state).toBe("running");
    manager.play(ELIMINATION);
    expect(ctx.oscillators).toHaveLength(1);
  });

  it("is safe when AudioContext is unavailable (headless/jsdom)", () => {
    const manager = new AudioManager({
      contextFactory: () => null,
      storage: null,
    });
    expect(() => {
      manager.unlock();
      manager.play(WINNER);
    }).not.toThrow();
    expect(manager.getSettings()).toEqual({ muted: false, volume: 0.7 });
  });

  it("does not throw when resume() is rejected by the browser", async () => {
    let factoryCalls = 0;
    const badCtx = new MockContext();
    const manager = new AudioManager({
      contextFactory: () => {
        factoryCalls += 1;
        return badCtx as unknown as AudioContextLike;
      },
      storage: null,
    });
    badCtx.state = "suspended";
    (badCtx as unknown as { resume: () => Promise<void> }).resume = () =>
      Promise.reject(new Error("not allowed"));
    expect(() => manager.unlock()).not.toThrow();
    await Promise.resolve(); // let the rejection settle
    expect(factoryCalls).toBe(1);
  });
});

describe("persistence", () => {
  it("persists settings and reloads them in a new manager", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const a = new AudioManager({ contextFactory: () => null, storage });
    a.setVolume(0.4);
    a.setMuted(true);
    const b = new AudioManager({ contextFactory: () => null, storage });
    expect(b.getSettings()).toEqual({ muted: true, volume: 0.4 });
  });

  it("tolerates corrupt persisted settings", () => {
    const storage = {
      getItem: () => "{not json",
      setItem: () => {},
      removeItem: () => {},
    };
    const manager = new AudioManager({ contextFactory: () => null, storage });
    expect(manager.getSettings()).toEqual({ muted: false, volume: 0.7 });
  });
});
