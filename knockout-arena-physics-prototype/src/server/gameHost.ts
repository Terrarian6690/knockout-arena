import {
  CONFIG,
  createGame,
  serializeGameState,
  validateCommand,
  type CommandResult,
  type GameCommand,
  type GameHandle,
  type GameState,
  type PlayerSpec,
} from "../game";

/**
 * Headless authoritative game host — the server-side owner of a match.
 *
 * This module is the first piece of the future multiplayer server. It wraps
 * exactly ONE engine `GameHandle` and owns it for the process lifetime of
 * the match:
 *
 *   - it creates the game from a SERVER-SUPPLIED roster (clients never
 *     contribute state, only commands);
 *   - it accepts player commands from the outside world (as `unknown`),
 *     runs the engine's structural validation on them, and forwards the
 *     survivors to the engine, which enforces ownership/phase rules;
 *   - it advances the simulation with a fixed 60 Hz timestep loop
 *     (Node timers — never the browser frame loop, never variable dt);
 *   - it caches the latest serialized authoritative state and pushes it to
 *     subscribers, so a transport layer only has to broadcast.
 *
 * The intended transport flow (deliberately transport-NEUTRAL — no
 * WebSocket/HTTP anywhere in this file):
 *
 *   receive command (wire)
 *     → host.submitCommand()        server validation + engine rules
 *     → host fixed ticks            60 Hz, exactly CONFIG.simulation.fixedTimestepMs
 *     → serializeGameState()        cached by the host on every state change
 *     → host.onStateChange(cb)      the transport broadcasts to clients
 *
 * The host contains NO game logic of its own: every rule (turn order,
 * elimination, settling, winning) lives in the engine. It also never
 * exposes the underlying `GameHandle` or a state-loading path — there is
 * nothing here a client could use to install state.
 */

/**
 * Options for createGameHost.
 */
export interface GameHostOptions {
  /** The match roster. Supplied by the server, never by a client. */
  players: PlayerSpec[];
  /**
   * Wall-clock source, used ONLY to decide how many fixed ticks are due —
   * never as a simulation delta. Injectable so tests can drive the loop
   * deterministically. Defaults to Date.now().
   */
  clock?: () => number;
  /**
   * Safety clamp: the maximum number of fixed ticks one loop wakeup may
   * execute after a stall (GC pause, process suspension). Excess backlog is
   * dropped rather than simulated in a burst. Default: 60 ticks (1 s).
   */
  maxCatchUpTicks?: number;
}

/** Listener pushed the serialized authoritative state on every change. */
export type SerializedStateListener = (serialized: string) => void;

/** Default anti-spiral clamp: at most one second of catch-up per wakeup. */
export const DEFAULT_MAX_CATCH_UP_TICKS = 60;

/**
 * The transport-neutral server interface. A future WebSocket layer needs
 * nothing else: submitCommand on message, onStateChange → broadcast.
 */
export interface GameHost {
  /** Start the fixed-timestep loop. Idempotent. Throws after destroy(). */
  start(): void;
  /** Stop the fixed-timestep loop (the match and its state are kept). Idempotent. */
  stop(): void;
  /** Whether the fixed-timestep loop is currently running. */
  isRunning(): boolean;
  /**
   * Validate and apply a command received from the outside world.
   * Accepts `unknown` on purpose: the payload is untrusted until the
   * engine's total validator has checked it. Returns the engine's
   * machine-readable result, ready to be acknowledged verbatim.
   * Never throws for malformed input; never installs client state.
   */
  submitCommand(command: unknown): CommandResult;
  /**
   * Advance the simulation by exactly one fixed tick
   * (CONFIG.simulation.fixedTimestepMs). The automatic loop calls this on a
   * cadence; tests and future tooling (replays, bots) may call it directly.
   * Works whether or not the loop is running. Throws after destroy().
   */
  tick(): void;
  /** How many fixed ticks this host has executed (loop + manual). */
  tickCount(): number;
  /**
   * The latest serialized authoritative state (the wire snapshot). Cached
   * and refreshed whenever the engine reports a change, so transports can
   * broadcast it without re-serializing.
   */
  serializedState(): string;
  /**
   * Subscribe to serialized state changes. The current snapshot is pushed
   * immediately (mirrors the engine's subscribe semantics), so a transport
   * that attaches late never misses the state it must broadcast first.
   * Returns an unsubscribe function.
   */
  onStateChange(listener: SerializedStateListener): () => void;
  /**
   * Full teardown: stops the loop, unsubscribes from the engine and
   * destroys it. Idempotent. Read accessors stay valid; start/tick/
   * submitCommand throw afterwards.
   */
  destroy(): void;
}

export function createGameHost(options: GameHostOptions): GameHost {
  if (
    !options ||
    !Array.isArray(options.players) ||
    options.players.length === 0
  ) {
    throw new Error("createGameHost: a non-empty players roster is required");
  }

  const tickMs = CONFIG.simulation.fixedTimestepMs;
  const clock = options.clock ?? Date.now;
  const maxCatchUpTicks = options.maxCatchUpTicks ?? DEFAULT_MAX_CATCH_UP_TICKS;

  // The authoritative game. Created from the server-supplied roster and
  // never handed out — the outside world can only reach it through
  // submitCommand (intents) and serializedState (output).
  const game: GameHandle = createGame({ players: options.players });

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPumpAt = 0;
  let backlogMs = 0;
  let ticks = 0;
  let destroyed = false;

  // Latest wire snapshot. The engine pushes its state on every change (and
  // once immediately), which is exactly when the serialized form must be
  // refreshed — cheap during aiming (no ticks → no emissions), always fresh
  // after commands and moving-phase ticks.
  let serialized = serializeGameState(game.getState());
  let stateListeners: SerializedStateListener[] = [];

  const unsubscribeEngine = game.subscribe((state: GameState) => {
    serialized = serializeGameState(state);
    for (const listener of [...stateListeners]) listener(serialized);
  });

  /**
   * One loop wakeup. Wall-clock time ONLY decides HOW MANY fixed ticks are
   * due; every tick always advances the simulation by exactly tickMs, so
   * scheduling jitter can never leak into the physics.
   */
  function pump(): void {
    const now = clock();
    const elapsed = Math.max(0, now - lastPumpAt);
    lastPumpAt = now;
    backlogMs += elapsed;

    const due = Math.floor(backlogMs / tickMs);
    if (due <= 0) return;
    if (due > maxCatchUpTicks) {
      // Long stall: run the allowed catch-up and DROP the rest of the
      // backlog instead of simulating a burst spiral.
      backlogMs = 0;
      for (let i = 0; i < maxCatchUpTicks; i++) tick();
      return;
    }
    backlogMs -= due * tickMs;
    for (let i = 0; i < due; i++) tick();
  }

  function start(): void {
    assertLive();
    if (timer !== null) return; // already running — idempotent
    lastPumpAt = clock();
    backlogMs = 0;
    timer = setInterval(pump, tickMs);
  }

  function stop(): void {
    if (timer === null) return; // already stopped — idempotent
    clearInterval(timer);
    timer = null;
  }

  function isRunning(): boolean {
    return timer !== null;
  }

  function submitCommand(command: unknown): CommandResult {
    assertLive();
    // Server-side validation: the engine's pure, total structural
    // validator (safe against any hostile input — it cannot throw).
    const validated = validateCommand(command);
    if (!validated.ok) return validated;
    // Ownership (unknown/wrong player), phase rules and all effects are
    // engine policy — the host adds none of its own. The try/catch is
    // defense-in-depth for the server boundary: nothing arriving from a
    // socket may ever crash the host process, even if a future engine
    // change introduces an accidental throw.
    try {
      return game.applyCommand(command as GameCommand);
    } catch {
      return { ok: false, reason: "invalid-command" };
    }
  }

  function tick(): void {
    assertLive();
    ticks += 1;
    // Exactly one fixed step. The engine's internal accumulator converts
    // it into exactly one physics tick while the phase is "moving" and
    // makes it a cheap no-op otherwise.
    game.update(tickMs);
  }

  function tickCount(): number {
    return ticks;
  }

  function serializedState(): string {
    return serialized;
  }

  function onStateChange(listener: SerializedStateListener): () => void {
    stateListeners.push(listener);
    // Push the current snapshot immediately, mirroring the engine's
    // subscribe semantics (a late-attaching transport must know what to
    // broadcast before the next change).
    listener(serialized);
    return () => {
      stateListeners = stateListeners.filter((l) => l !== listener);
    };
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    stop();
    unsubscribeEngine();
    stateListeners = [];
    game.destroy();
  }

  function assertLive(): void {
    if (destroyed) {
      throw new Error("GameHost: this host has been destroyed");
    }
  }

  return {
    start,
    stop,
    isRunning,
    submitCommand,
    tick,
    tickCount,
    serializedState,
    onStateChange,
    destroy,
  };
}
