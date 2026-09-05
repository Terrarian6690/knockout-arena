import type { VfxEvent } from "./effects";

/**
 * Client-side sound effects (Task 19) — synthesized with the native Web
 * Audio API only: oscillators, gain nodes and one lowpass filter per
 * sound that needs it. No audio files, no third-party library.
 *
 * Event source: the VFX system's `observe()` diff of consecutive
 * AUTHORITATIVE snapshots (src/client/effects.ts) — there is exactly ONE
 * detector; this module only turns the reported events into sound.
 * Because the events come from authoritative transitions, duplicate
 * snapshots, re-rendered frames, aim-preview changes and reconnect
 * re-pushes can never replay a sound.
 *
 * Autoplay policy: audio starts only after a legitimate user gesture.
 * `unlock()` is called from real interactions (pointer down on the
 * arena, the Launch/power buttons, the volume control); it lazily
 * creates the single AudioContext and resumes it. Until the context is
 * "running", `play()` silently skips — no throw, nothing blocks a game
 * command.
 *
 * Sound design (short, distinct, quiet — peaks ≤ ~0.4 before the master
 * volume): launch = a filtered whoosh that gets lower/stronger with
 * power; impact = a fast pitched-down thock scaled by closing strength;
 * elimination = a descending arcade sweep; round-start = a rising blip;
 * winner = a three-note ascending arpeggio (≤ 800 ms). Every tone uses
 * a short linear attack and an exponential decay so nothing clicks or
 * clips.
 */

/** Hard bound on simultaneously scheduled tones (§ performance). */
export const MAX_ACTIVE_SOUNDS = 16;

/** Default: enabled at a moderate volume. */
const DEFAULT_VOLUME = 0.7;
const STORAGE_KEY = "knockout-audio";

// ── Structural Web Audio types (the real API satisfies these; tests mock
// them). Kept minimal so mocks stay small and nothing needs a real
// AudioContext anywhere in the test suite.
interface ParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

interface AudioNodeLike {
  connect(destination: AudioNodeLike): AudioNodeLike;
  disconnect(): void;
}

interface GainLike extends AudioNodeLike {
  gain: ParamLike;
}

interface OscLike extends AudioNodeLike {
  type: string;
  frequency: ParamLike;
  start(when?: number): void;
  stop(when: number): void;
  onended: (() => void) | null;
}

interface FilterLike extends AudioNodeLike {
  type: string;
  frequency: ParamLike;
}

export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  createOscillator(): OscLike;
  createGain(): GainLike;
  createBiquadFilter(): FilterLike;
  resume(): Promise<void>;
}

export interface AudioManagerOptions {
  /** Test seam: supplies (or fails to supply) the audio context. */
  readonly contextFactory?: () => AudioContextLike | null;
  /** Test seam: settings persistence (defaults to localStorage if present). */
  readonly storage?: StorageLike | null;
  /** Bound on scheduled tones (defaults to MAX_ACTIVE_SOUNDS). */
  readonly maxActiveSounds?: number;
}

/** The slice of Storage the manager uses (localStorage in browsers). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AudioSettings {
  readonly muted: boolean;
  readonly volume: number;
}

/** The browser's AudioContext, if this environment has one. */
function defaultContextFactory(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const w = window as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  if (typeof ctor !== "function") return null;
  try {
    return new (ctor as new () => AudioContextLike)();
  } catch {
    return null; // some browsers throw when too many contexts exist
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // SecurityError in some privacy modes — run without persistence.
  }
  return null;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** One synthesized tone: oscillator → (optional lowpass) → gain → master. */
interface ToneSpec {
  /** Oscillator waveform ("sine" | "square" | "sawtooth" | "triangle"). */
  readonly wave: string;
  /** Start frequency (Hz). */
  readonly from: number;
  /** Optional end frequency (Hz) — a sweep. */
  readonly to?: number;
  /** Total lifetime in seconds. */
  readonly life: number;
  /** Peak gain (before master volume). */
  readonly peak: number;
  /** Attack time in seconds (short, to avoid clicks). */
  readonly attack?: number;
  /** Optional lowpass cutoff (Hz). */
  readonly filter?: number;
  /** Start delay in seconds (for arpeggios). */
  readonly delay?: number;
}

export class AudioManager {
  private readonly factory: () => AudioContextLike | null;
  private readonly storage: StorageLike | null;
  private readonly maxActive: number;

  private context: AudioContextLike | null = null;
  private master: GainLike | null = null;
  private active = 0;
  private muted = false;
  private volume = DEFAULT_VOLUME;

  constructor(options: AudioManagerOptions = {}) {
    this.factory = options.contextFactory ?? defaultContextFactory;
    this.storage = options.storage ?? defaultStorage();
    this.maxActive = options.maxActiveSounds ?? MAX_ACTIVE_SOUNDS;
    this.loadSettings();
  }

  // ── Settings (volume/mute; gain control, never teardown) ─────────────

  getMuted(): boolean {
    return this.muted;
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
    this.saveSettings();
  }

  /** Master volume 0..1 — clamped, applied through the master gain node. */
  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    this.applyMasterGain();
    this.saveSettings();
  }

  /** Settings snapshot (for the UI control's initial state). */
  getSettings(): AudioSettings {
    return { muted: this.muted, volume: this.volume };
  }

  /**
   * Back to defaults and drop the (page-lifetime) context. Used by tests
   * and any future "reset preferences" surface; normal volume changes
   * never do this — gain control only.
   */
  reset(): void {
    this.muted = false;
    this.volume = DEFAULT_VOLUME;
    if (this.context !== null) {
      try {
        this.master?.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.context = null;
    this.master = null;
    this.active = 0;
    this.saveSettings();
  }

  // ── Autoplay handling ────────────────────────────────────────────────

  /**
   * A legitimate user gesture happened (pointer down on the arena, a
   * control click…). Lazily create the single AudioContext and resume it
   * if the browser still has it suspended. Never throws, never blocks:
   * the resume promise is fire-and-forget.
   */
  unlock(): void {
    const ctx = this.ensureContext();
    if (ctx === null) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {
        // Still not allowed — play() will keep skipping silently.
      });
    }
  }

  // ── Event playback ───────────────────────────────────────────────────

  /**
   * Turn a batch of detected VFX events into sound. Launches within one
   * batch coalesce into a single whoosh at the strongest revealed power
   * (a round resolving is one audible moment, not N stacked whooshes).
   * Silently skips everything when muted, at zero volume, without an
   * AudioContext, or while the context is not yet "running".
   */
  play(events: readonly VfxEvent[]): void {
    if (events.length === 0) return;
    if (this.muted || this.volume <= 0) return;
    const ctx = this.ensureContext();
    if (ctx === null || ctx.state !== "running") return;

    let launchPower = -1;
    for (const event of events) {
      switch (event.type) {
        case "round-start":
          this.roundStart();
          break;
        case "impact":
          this.impact(event.strength);
          break;
        case "elimination":
          this.elimination();
          break;
        case "winner":
          this.winner();
          break;
        case "launch":
          launchPower = Math.max(launchPower, event.power);
          break;
      }
    }
    if (launchPower > 0) this.launch(launchPower);
  }

  /** Number of tones currently scheduled (bounded by maxActiveSounds). */
  get activeSounds(): number {
    return this.active;
  }

  // ── The sounds (distinct: wave, sweep, length, envelope, filter) ─────

  /** Launch whoosh: higher power → lower, stronger, slightly longer. */
  private launch(power: number): void {
    const p = Math.min(5, Math.max(1, power));
    this.tone({
      wave: "sawtooth",
      from: 200 - p * 15,
      to: 55,
      life: 0.12 + p * 0.02,
      peak: 0.12 + p * 0.04,
      filter: 650 + p * 110,
    });
  }

  /** Impact thock: faster/harder with the closing strength. */
  private impact(strength: number): void {
    const s = Math.min(4, Math.max(0.5, strength));
    this.tone({
      wave: "triangle",
      from: 210,
      to: 65,
      life: 0.07 + s * 0.015,
      peak: 0.18 + s * 0.04,
      filter: 900,
    });
  }

  /** Elimination: a soft descending arcade sweep. */
  private elimination(): void {
    this.tone({
      wave: "sawtooth",
      from: 360,
      to: 80,
      life: 0.3,
      peak: 0.26,
      filter: 1000,
    });
  }

  /** Round start: a short rising blip — "the round is going". */
  private roundStart(): void {
    this.tone({ wave: "sine", from: 523, to: 660, life: 0.09, peak: 0.16 });
  }

  /** Winner: a three-note ascending arpeggio (≤ 800 ms total). */
  private winner(): void {
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((frequency, i) => {
      this.tone({
        wave: "sine",
        from: frequency,
        life: 0.3,
        peak: 0.2,
        delay: i * 0.13,
      });
    });
  }

  // ── Synthesis plumbing ───────────────────────────────────────────────

  /** Schedule one tone; skip when the active-sound bound is reached. */
  private tone(spec: ToneSpec): void {
    const ctx = this.context;
    const master = this.master;
    if (ctx === null || master === null) return;
    if (this.active >= this.maxActive) return; // bounded, newest dropped

    const t0 = ctx.currentTime + (spec.delay ?? 0);
    const attack = spec.attack ?? 0.008;

    const osc = ctx.createOscillator();
    osc.type = spec.wave;
    osc.frequency.setValueAtTime(Math.max(1, spec.from), t0);
    if (spec.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + spec.life * 0.9);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(spec.peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.life);

    let head: AudioNodeLike = osc;
    if (spec.filter !== undefined) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(spec.filter, t0);
      osc.connect(filter);
      head = filter;
    }
    head.connect(gain);
    gain.connect(master);

    this.active += 1;
    osc.onended = () => {
      this.active -= 1;
      // Let the scheduled nodes go — no leaks, no permanent graph growth.
      osc.disconnect();
      gain.disconnect();
      if (head !== osc) head.disconnect();
      osc.onended = null;
    };
    osc.start(t0);
    osc.stop(t0 + spec.life + 0.05);
  }

  /** The single lazily-created context + its persistent master gain. */
  private ensureContext(): AudioContextLike | null {
    if (this.context !== null) return this.context;
    const ctx = this.factory();
    if (ctx === null) return null;
    const master = ctx.createGain();
    master.connect(ctx.destination);
    this.master = master;
    this.context = ctx;
    this.applyMasterGain();
    return ctx;
  }

  /** Master gain = volume when unmuted (0 when muted); node survives. */
  private applyMasterGain(): void {
    if (this.master !== null) {
      this.master.gain.value = this.muted ? 0 : this.volume;
    }
  }

  private loadSettings(): void {
    if (this.storage === null) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as Partial<AudioSettings>;
      if (typeof parsed.muted === "boolean") this.muted = parsed.muted;
      if (typeof parsed.volume === "number") this.volume = clampVolume(parsed.volume);
    } catch {
      // Corrupt or unavailable — keep the defaults.
    }
  }

  private saveSettings(): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ muted: this.muted, volume: this.volume })
      );
    } catch {
      // Quota/private mode — settings just won't persist.
    }
  }
}

/** The page-wide manager (client-only; safe in any environment). */
export const audio = new AudioManager();
