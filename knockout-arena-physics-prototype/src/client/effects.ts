import { floorRadius, playerColor, type Arena, type GameStateSnapshot, type PawnSnapshot } from "../game";

/**
 * Render-only visual effects (Task 18) — the game-feel layer.
 *
 * Everything here is DERIVED presentation state on top of authoritative
 * snapshots: no effect ever touches pawn positions, velocities, physics,
 * game state, round resolution or the wire. The data flow stays exactly
 * the Task 17 pipeline, with this module sitting between interpolation
 * and the renderer:
 *
 *   authoritative snapshot → buffer → interpolated visual position
 *                        → VFX (this module) → renderer → canvas
 *
 * Two inputs, two outputs:
 *
 *   • `observe(prev, next, now)` — runs ONCE PER AUTHORITATIVE PUSH and
 *     compares content (phase, eliminations, launches, pawn distances) to
 *     spawn one-shot effects. Content-based, so duplicate pushes and the
 *     optimistic aim overlay never re-trigger anything.
 *   • `sampleTrails(visual, now)` — runs in the draw path and samples the
 *     RENDERED (interpolated) positions for movement trails.
 *
 *   • `buildFrame(now)` — a plain, baked draw list for the renderer
 *     (trails under rings under particles, all UNDER the pawns).
 *   • `shakeOffset(now)` — a tiny screen-space offset the caller adds to
 *     the RENDER transform only; the input/world coordinate math never
 *     sees it.
 *
 * Bounds: every array is capped, every effect expires, and phase changes
 * (round boundaries, match reset, new match) clear transient state.
 * `prefers-reduced-motion` disables shake and halves particle counts.
 * Pure and clock-driven: callers supply `now`, tests supply a
 * deterministic `random` — no timers, no DOM (the matchMedia probe is
 * guarded and only called by the UI).
 */

/** All tunables in one place (durations in ms, distances in world units). */
export const VFX = {
  /** Launch burst lifetime (spec budget: 100–250 ms). */
  launchLife: 200,
  /** Movement trail point lifetime. */
  trailLife: 320,
  /** Minimum rendered movement before a new trail point is sampled. */
  trailMinStep: 5,
  /** Maximum trail points per pawn (hard bound). */
  trailMaxPoints: 10,
  /** Collision impact lifetime. */
  collisionLife: 260,
  /** Contact detection: distance margin beyond the two radii (units). */
  collisionContactMargin: 3,
  /** Minimum approach per push interval for a "meaningful" hit (units). */
  collisionMinClosing: 0.5,
  /** Approach speed that additionally earns a small screen shake (units). */
  collisionShakeClosing: 2,
  /** Per-pawn-pair impact cooldown (ms) — resting contact never re-fires. */
  collisionCooldown: 280,
  /** Elimination effect lifetime (spec budget: 300–600 ms). */
  eliminationLife: 500,
  /** Winner celebration burst lifetime. */
  winnerBurstLife: 650,
  /** Round-start ring lifetime. */
  roundStartLife: 320,
  /** Global particle cap (guideline budget: 12 + 16 + 24 + 32 = 84). */
  maxParticles: 96,
  /** Global ring cap. */
  maxRings: 12,
  /** Maximum screen-shake amplitude (CSS pixels). */
  shakeMax: 3,
  /** Accent color for round-start / collision / winner effects. */
  accent: "#ffd166",
  /** Arena glow color for the round-start ring. */
  arenaGlow: "#7ea8d1",
} as const;

/** One baked trail dot (position/radius/alpha resolved at build time). */
export interface EffectDot {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly alpha: number;
  readonly color: string;
}

/** One baked expanding ring stroke. */
export interface EffectRingView {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly alpha: number;
  readonly color: string;
  readonly width: number;
}

/** Everything the renderer draws for one frame, UNDER the pawns. */
export interface EffectFrame {
  readonly trails: readonly EffectDot[];
  readonly rings: readonly EffectRingView[];
  readonly particles: readonly EffectDot[];
}

const EMPTY_FRAME: EffectFrame = { trails: [], rings: [], particles: [] };

/**
 * A gameplay event detected by diffing two consecutive AUTHORITATIVE
 * snapshots. The VFX system spawns its visuals from these transitions;
 * the audio system (src/client/audio.ts) consumes the SAME events — there
 * is exactly one detector (§ Task 19: no second collision/event system).
 */
export type VfxEvent =
  | { readonly type: "round-start" }
  /** A pawn's revealed launch (power 1..5) as the round starts resolving. */
  | { readonly type: "launch"; readonly power: number }
  /** A supported pawn-vs-pawn impact (strength = closing distance/tick). */
  | { readonly type: "impact"; readonly strength: number }
  /** A pawn transitioned to eliminated. */
  | { readonly type: "elimination" }
  /** The match finished with an authoritative winner. */
  | { readonly type: "winner" };

/** A live particle (world units; velocities in units per ms). */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bornAt: number;
  advancedTo: number;
  life: number;
  size: number;
  color: string;
}

/** A live expanding ring. */
interface Ring {
  x: number;
  y: number;
  bornAt: number;
  life: number;
  fromR: number;
  toR: number;
  color: string;
  width: number;
  alpha: number;
}

/** Per-pawn trail bookkeeping. */
interface Trail {
  colorIndex: number;
  radius: number;
  points: { x: number; y: number; at: number }[];
  lastSample: { x: number; y: number };
}

/** Active screen shake (render transform only — never input math). */
interface Shake {
  bornAt: number;
  until: number;
  amplitude: number;
  phase: number;
}

export interface VfxOptions {
  /** Honor prefers-reduced-motion: no shake, ~half the particles. */
  readonly reducedMotion?: boolean;
  /** Injectable randomness (defaults to Math.random); tests seed it. */
  readonly random?: () => number;
  /** The arena (round-start ring center/radius). */
  readonly arena?: Arena;
}

/**
 * Detects the user's reduced-motion preference. Guarded so it is safe in
 * any environment (node tests, jsdom without matchMedia); defaults to
 * FULL motion — effects are decorative, never informational.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export class Vfx {
  private readonly reduced: boolean;
  private readonly rng: () => number;
  private readonly arena: Arena | null;

  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private readonly trails = new Map<string, Trail>();
  private shake: Shake | null = null;
  private readonly lastImpact = new Map<string, number>();

  constructor(options: VfxOptions = {}) {
    this.reduced = options.reducedMotion ?? false;
    this.rng = options.random ?? Math.random;
    this.arena = options.arena ?? null;
  }

  // ── Event detection (once per authoritative push) ──────────────────────

  /**
   * Compare two consecutive AUTHORITATIVE snapshots, spawn one-shot
   * effects from the observed transitions and RETURN the detected events
   * (consumed by the audio layer — this is the single event source).
   * `prev === null` (mount/reconnect) never spawns: no fireworks and no
   * replayed history for a joining viewer.
   */
  observe(prev: GameStateSnapshot | null, next: GameStateSnapshot, now: number): readonly VfxEvent[] {
    const events: VfxEvent[] = [];
    if (prev === null) return events;
    const phaseChanged = prev.phase !== next.phase;

    if (phaseChanged) {
      // Round/match boundaries: transient effects must not smear across
      // them — clear first, then spawn whatever the NEW phase earns.
      this.clearTransient();
      if (prev.phase === "aiming" && next.phase === "moving") {
        this.roundStart(now);
        events.push({ type: "round-start" });
        for (const pawn of next.pawns) {
          // Truthy check, mirroring the renderer: wire pawns may omit the
          // launch field entirely (older/looser fixtures) — only a real
          // revealed launch earns a burst.
          if (pawn.launch && !pawn.eliminated) {
            this.launchBurst(pawn, now);
            events.push({ type: "launch", power: pawn.launch.power });
          }
        }
      }
    }

    // Eliminations: the burst starts at the AUTHORITATIVE position of the
    // snapshot that first reports the pawn eliminated.
    for (const pawn of next.pawns) {
      const before = prev.pawns.find((p) => p.id === pawn.id);
      if (before === undefined) continue;
      if (!before.eliminated && pawn.eliminated) {
        this.eliminationBurst(pawn, now);
        events.push({ type: "elimination" });
      } else if (before.eliminated && !pawn.eliminated) {
        // A pawn coming back alive = the match was reset. Drop every
        // transient effect so the new match starts visually clean.
        this.clearTransient();
      }
    }

    // Winner celebration: only when the AUTHORITATIVE phase becomes
    // "finished" with a declared winner (the halo itself is a pure render
    // rule off snapshot.winnerId — see renderer).
    const winnerId = next.winnerId ?? null; // tolerate an absent field
    if (phaseChanged && next.phase === "finished" && winnerId !== null) {
      const winner = next.pawns.find((p) => p.id === winnerId && !p.eliminated);
      if (winner !== undefined) {
        this.winnerBurst(winner, now);
        events.push({ type: "winner" });
      }
    }

    // Pawn-vs-pawn impacts, derived conservatively from AUTHORITATIVE
    // positions only (never the interpolated visuals): two alive pawns
    // still approaching while already within contact distance. The wire
    // carries no collision events, so this is a visual approximation —
    // resting/sliding contact (no approach) and slow nudges never fire.
    if (prev.phase === "moving" && next.phase === "moving") {
      for (const strength of this.detectImpacts(prev, next, now)) {
        events.push({ type: "impact", strength });
      }
    }
    return events;
  }

  /**
   * Pairwise contact approach test (see observe). Returns the closing
   * strength of every impact that fired (the same cooldown/event
   * semantics the visual effect uses — there is only this one detector).
   */
  private detectImpacts(prev: GameStateSnapshot, next: GameStateSnapshot, now: number): number[] {
    const fired: number[] = [];
    const pawns = next.pawns;
    for (let i = 0; i < pawns.length; i++) {
      for (let j = i + 1; j < pawns.length; j++) {
        const a = pawns[i]!;
        const b = pawns[j]!;
        if (a.eliminated || b.eliminated) continue;
        const pa = prev.pawns.find((p) => p.id === a.id);
        const pb = prev.pawns.find((p) => p.id === b.id);
        if (pa === undefined || pb === undefined || pa.eliminated || pb.eliminated) continue;

        const dPrev = Math.hypot(pa.position.x - pb.position.x, pa.position.y - pb.position.y);
        const dNext = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        const contact = a.radius + b.radius + VFX.collisionContactMargin;
        const closing = dPrev - dNext;

        if (dNext > contact || closing < VFX.collisionMinClosing) continue;

        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const last = this.lastImpact.get(key) ?? -Infinity;
        if (now - last < VFX.collisionCooldown) continue;
        this.lastImpact.set(key, now);

        const x = (a.position.x + b.position.x) / 2;
        const y = (a.position.y + b.position.y) / 2;
        this.spawnRing(x, y, Math.min(a.radius, b.radius), Math.min(a.radius, b.radius) + 16, VFX.collisionLife, VFX.accent, 2, 0.6, now);
        this.spawnBurst(x, y, this.count(10), 0.05, 0.11, VFX.collisionLife, 1.8, 2.8, "#ffffff", now);
        if (closing >= VFX.collisionShakeClosing) {
          this.addShake(2, 150, now);
        }
        fired.push(closing);
      }
    }
    return fired;
  }

  // ── Trail sampling (draw path, from RENDERED positions) ────────────────

  /**
   * Sample the interpolated visual positions for movement trails. A point
   * is recorded only when the pawn has RENDERED at least `trailMinStep`
   * units since the last sample — stationary pawns never generate points,
   * and the per-pawn history is hard-capped.
   */
  sampleTrails(visual: GameStateSnapshot, now: number): void {
    if (visual.phase !== "moving") return;
    for (const pawn of visual.pawns) {
      if (pawn.eliminated) continue;
      let trail = this.trails.get(pawn.id);
      if (trail === undefined) {
        trail = {
          colorIndex: pawn.colorIndex,
          radius: pawn.radius,
          points: [],
          lastSample: { x: pawn.position.x, y: pawn.position.y },
        };
        this.trails.set(pawn.id, trail);
        continue; // first sight: baseline only, no dot
      }
      const dx = pawn.position.x - trail.lastSample.x;
      const dy = pawn.position.y - trail.lastSample.y;
      if (dx * dx + dy * dy < VFX.trailMinStep * VFX.trailMinStep) continue;
      trail.points.push({ x: pawn.position.x, y: pawn.position.y, at: now });
      while (trail.points.length > VFX.trailMaxPoints) trail.points.shift();
      trail.lastSample = { x: pawn.position.x, y: pawn.position.y };
    }
  }

  // ── Frame building (draw path) ─────────────────────────────────────────

  /** Whether anything visual is still animating (repaint-guard hint). */
  hasActivity(now: number): boolean {
    if (this.shake !== null && now < this.shake.until) return true;
    for (const p of this.particles) if (now < p.bornAt + p.life) return true;
    for (const r of this.rings) if (now < r.bornAt + r.life) return true;
    for (const t of this.trails.values()) {
      for (const p of t.points) if (now < p.at + VFX.trailLife) return true;
    }
    return false;
  }

  /**
   * Bake the draw list for `now`: advances particle physics, prunes
   * expired entries and returns plain data for the renderer. Returns the
   * SAME empty object when nothing is active (zero allocation).
   */
  buildFrame(now: number): EffectFrame {
    let any = false;
    const trails: EffectDot[] = [];
    const rings: EffectRingView[] = [];
    const particles: EffectDot[] = [];

    for (const trail of this.trails.values()) {
      trail.points = trail.points.filter((p) => now < p.at + VFX.trailLife);
      if (trail.points.length > 0) any = true;
      for (const p of trail.points) {
        const k = 1 - (now - p.at) / VFX.trailLife; // 1 → 0 over its life
        if (k <= 0) continue;
        trails.push({
          x: p.x,
          y: p.y,
          r: trail.radius * 0.32 * k,
          alpha: 0.3 * k,
          color: playerColor(trail.colorIndex),
        });
      }
    }

    if (this.rings.length > 0) {
      this.rings = this.rings.filter((r) => now < r.bornAt + r.life);
      for (const r of this.rings) {
        any = true;
        const t = (now - r.bornAt) / r.life; // 0 → 1
        rings.push({
          x: r.x,
          y: r.y,
          r: r.fromR + (r.toR - r.fromR) * t,
          alpha: r.alpha * (1 - t),
          color: r.color,
          width: r.width,
        });
      }
    }

    if (this.particles.length > 0) {
      this.particles = this.particles.filter((p) => now < p.bornAt + p.life);
      for (const p of this.particles) {
        any = true;
        const dt = Math.max(0, now - p.advancedTo);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.advancedTo = now;
        const k = 1 - (now - p.bornAt) / p.life; // 1 → 0 over its life
        particles.push({
          x: p.x,
          y: p.y,
          r: p.size * Math.max(0.4, k),
          alpha: Math.min(1, 0.85 * k),
          color: p.color,
        });
      }
    }

    if (!any) return EMPTY_FRAME;
    return { trails, rings, particles };
  }

  /**
   * The screen-space shake offset for `now` (CSS pixels, bounded by
   * VFX.shakeMax, decaying to zero). Intended for the RENDER transform
   * only — the pointer → world conversion must never include it.
   */
  shakeOffset(now: number): { x: number; y: number } {
    const s = this.shake;
    if (s === null || now >= s.until) return { x: 0, y: 0 };
    const total = s.until - s.bornAt;
    const decay = total > 0 ? 1 - (now - s.bornAt) / total : 0;
    return {
      x: s.amplitude * decay * Math.sin(now * 0.09 + s.phase),
      y: s.amplitude * decay * Math.cos(now * 0.077 + s.phase),
    };
  }

  /** Drop every transient effect (trails, particles, rings, shake). */
  clearTransient(): void {
    this.particles = [];
    this.rings = [];
    this.trails.clear();
    this.shake = null;
  }

  // ── Effect spawners ────────────────────────────────────────────────────

  /**
   * Launch burst: a short cone of particles BEHIND the pawn, opposite the
   * REVEALED launch direction (the committed fact — no new trajectory is
   * computed), intensity scaling with the committed power.
   */
  private launchBurst(pawn: PawnSnapshot, now: number): void {
    const dir = pawn.launch!.direction;
    const power = pawn.launch!.power;
    const back = Math.atan2(-dir.y, -dir.x);
    const count = this.count(Math.min(12, 5 + power));
    const color = playerColor(pawn.colorIndex);
    for (let i = 0; i < count; i++) {
      const angle = back + (this.rng() - 0.5) * 1.1;
      const speed = 0.05 + 0.014 * power + this.rng() * 0.05;
      this.spawnParticle(
        pawn.position.x - dir.x * pawn.radius * 0.6,
        pawn.position.y - dir.y * pawn.radius * 0.6,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        VFX.launchLife * (0.7 + this.rng() * 0.3),
        1.8 + this.rng() * 1.4,
        color,
        now
      );
    }
  }

  /** Elimination: radial burst + expanding ring at the authoritative spot. */
  private eliminationBurst(pawn: PawnSnapshot, now: number): void {
    const color = playerColor(pawn.colorIndex);
    this.trails.delete(pawn.id); // no ghost trail behind a gone pawn
    this.spawnRing(
      pawn.position.x,
      pawn.position.y,
      pawn.radius,
      pawn.radius * 3.2,
      VFX.eliminationLife,
      color,
      2.5,
      0.7,
      now
    );
    const count = this.count(20);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.rng() * 0.5;
      const speed = 0.08 + this.rng() * 0.1;
      this.spawnParticle(
        pawn.position.x + Math.cos(angle) * pawn.radius,
        pawn.position.y + Math.sin(angle) * pawn.radius,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        VFX.eliminationLife * (0.6 + this.rng() * 0.4),
        2 + this.rng() * 2,
        this.rng() < 0.25 ? "#ffffff" : color,
        now
      );
    }
    this.addShake(3, 200, now);
  }

  /** Winner celebration: gold-accented fountain at the winner's position. */
  private winnerBurst(pawn: PawnSnapshot, now: number): void {
    const color = playerColor(pawn.colorIndex);
    this.spawnRing(
      pawn.position.x,
      pawn.position.y,
      pawn.radius,
      pawn.radius * 2.6,
      500,
      VFX.accent,
      2,
      0.7,
      now
    );
    const count = this.count(26);
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (this.rng() - 0.5) * 2.4; // upward fan
      const speed = 0.06 + this.rng() * 0.1;
      this.spawnParticle(
        pawn.position.x,
        pawn.position.y,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        VFX.winnerBurstLife * (0.6 + this.rng() * 0.4),
        2 + this.rng() * 1.6,
        this.rng() < 0.5 ? VFX.accent : color,
        now
      );
    }
  }

  /** Round start: one subtle ring expanding from the arena center. */
  private roundStart(now: number): void {
    const arena = this.arena;
    if (arena === null) return;
    this.spawnRing(
      arena.centerX,
      arena.centerY,
      arena.radius * 0.12,
      floorRadius(arena),
      VFX.roundStartLife,
      VFX.arenaGlow,
      2,
      0.35,
      now
    );
  }

  // ── Low-level spawns (all bounded) ─────────────────────────────────────

  private spawnParticle(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    color: string,
    now: number
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.particles.push({ x, y, vx, vy, bornAt: now, advancedTo: now, life, size, color });
    while (this.particles.length > VFX.maxParticles) this.particles.shift();
  }

  /** Radial burst helper (white/neutral sparks). */
  private spawnBurst(
    x: number,
    y: number,
    count: number,
    minSpeed: number,
    maxSpeed: number,
    life: number,
    minSize: number,
    maxSize: number,
    color: string,
    now: number
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.rng() * 0.6;
      const speed = minSpeed + this.rng() * (maxSpeed - minSpeed);
      this.spawnParticle(
        x,
        y,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        life * (0.7 + this.rng() * 0.3),
        minSize + this.rng() * (maxSize - minSize),
        color,
        now
      );
    }
  }

  private spawnRing(
    x: number,
    y: number,
    fromR: number,
    toR: number,
    life: number,
    color: string,
    width: number,
    alpha: number,
    now: number
  ): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.rings.push({ x, y, bornAt: now, life, fromR, toR, color, width, alpha });
    while (this.rings.length > VFX.maxRings) this.rings.shift();
  }

  /** Screen shake (skipped entirely under reduced motion). */
  private addShake(amplitude: number, durationMs: number, now: number): void {
    if (this.reduced) return;
    const current = this.shake;
    const next = {
      bornAt: now,
      until: now + durationMs,
      amplitude: Math.min(amplitude, VFX.shakeMax),
      phase: this.rng() * Math.PI * 2,
    };
    if (current !== null && current.until > now && current.amplitude >= next.amplitude) return;
    this.shake = next;
  }

  /** Particle count for a full-motion effect (halved under reduced motion). */
  private count(full: number): number {
    return this.reduced ? Math.ceil(full / 2) : full;
  }
}
