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
 * The host owns exactly ONE piece of orchestration policy on top of the
 * engine: the ROUND DECISION DEADLINE. While a match is in the "aiming"
 * phase, the host arms a wall-clock deadline (default 10 s); when it fires
 * the host submits the engine's match-level `resolveRound` command through
 * the exact same authoritative path the room manager's privileged facade
 * uses. All gameplay rules — who may confirm, who moves, elimination,
 * settling, winning — stay in the engine; the deadline only decides WHEN
 * the existing resolution is invoked. It never feeds wall-clock time into
 * the simulation: physics keeps advancing by exactly tickMs per tick. The
 * engine emits every state change to this module's subscription, which is
 * how the deadline is armed on each entry into "aiming" and cancelled on
 * each exit (early all-confirmed resolution, timeout resolution, match
 * finish). Because the deadline is checked inside the tick loop — never a
 * detached setTimeout callback — stop()/destroy() structurally prevent
 * stale firings, and a deadline from an older round cannot survive into a
 * newer one.
 *
 * The host otherwise contains NO game logic of its own: every rule
 * (elimination, settling, winning) lives in the engine. It also never
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
  /**
   * The round decision deadline: the maximum wall-clock time an "aiming"
   * round may last. When it expires the host resolves the round with
   * whatever confirmations exist (confirmed players move, unconfirmed
   * players do not). Default: DEFAULT_ROUND_DECISION_TIMEOUT_MS (10 s).
   * Server-side configuration only — clients never influence it.
   */
  roundDecisionTimeoutMs?: number;
}

/** Listener pushed the serialized authoritative state on every change. */
export type SerializedStateListener = (serialized: string) => void;

/** Default anti-spiral clamp: at most one second of catch-up per wakeup. */
export const DEFAULT_MAX_CATCH_UP_TICKS = 60;

/**
 * Default round decision deadline: an aiming round is resolved by the
 * server after ten seconds even if not every alive player has confirmed.
 */
export const DEFAULT_ROUND_DECISION_TIMEOUT_MS = 10_000;

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
   * The wall-clock time (in the host's clock domain) at which the CURRENT
   * aiming round's decision deadline fires, or null when no deadline is
   * armed (the round is resolving, the match is finished, or the host is
   * destroyed). Observability for tests and future server-derived UI; the
   * deadline itself is enforced inside the tick loop.
   */
  roundDeadline(): number | null;
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
  const roundDecisionTimeoutMs =
    options.roundDecisionTimeoutMs ?? DEFAULT_ROUND_DECISION_TIMEOUT_MS;

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

  /**
   * The current aiming round's decision deadline (the host's timer token).
   * Invariant: this is non-null IFF the latest engine state observed by the
   * subscription below has phase "aiming". It is armed on every ENTRY into
   * aiming (a fresh fireAt per round — the initial round, every round after
   * a settle, and a reset's new match) and cleared on every EXIT (early
   * all-confirmed resolution, deadline resolution, match finish). Since it
   * is re-read synchronously inside the tick loop and never captured by a
   * detached callback, a deadline belonging to an older round cannot
   * survive into a newer one: it stops existing the moment its round ends.
   */
  let roundDeadline: number | null = null;

  /**
   * Phase tracking: arm/cancel the round decision deadline. The engine
   * emits on every state change, so this runs exactly once per transition
   * (and cheaply no-ops for non-phase changes within the same round).
   */
  function observePhase(phase: GameState["phase"]): void {
    if (phase === "aiming") {
      if (roundDeadline === null) {
        roundDeadline = clock() + roundDecisionTimeoutMs;
      }
    } else {
      roundDeadline = null;
    }
  }

  /**
   * Fire the deadline if the current aiming round's time is up. One-shot
   * per round: the token is consumed before resolving, so the same round
   * can never be resolved twice by it. The resolution re-enters through
   * submitCommand() — the same authoritative command path as the room
   * manager's privileged resolveRound() facade — so the host adds no
   * resolution logic of its own. Wall-clock time decides only WHETHER it
   * is due, never any simulation input.
   */
  function checkRoundDeadline(): void {
    if (roundDeadline === null) return; // no aiming round in progress
    if (clock() < roundDeadline) return; // not due yet
    roundDeadline = null; // consumed: exactly one resolution per round
    submitCommand({ type: "resolveRound" });
  }

  const unsubscribeEngine = game.subscribe((state: GameState) => {
    observePhase(state.phase);
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
    if (due <= 0) {
      // No fixed tick is due yet, but the round deadline may fall between
      // ticks — check it so the resolution fires within one wakeup.
      checkRoundDeadline();
      return;
    }
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
    // A reset opens a FRESH match with a FRESH decision window — and the
    // engine emits the reset state synchronously INSIDE applyCommand,
    // before any post-apply reconciliation could run. The token must be
    // replaced FIRST so the broadcast that follows carries the NEW
    // window: an aiming → aiming reset is invisible to the phase tracker,
    // which only re-arms when the token is null. If the reset is rejected
    // (no state change, no emit), the old window is restored untouched.
    const isReset = (command as GameCommand).type === "reset";
    const previousDeadline = isReset ? roundDeadline : null;
    if (isReset) {
      roundDeadline = clock() + roundDecisionTimeoutMs;
    }
    // Ownership (unknown/wrong player), phase rules and all effects are
    // engine policy — the host adds none of its own. The try/catch is
    // defense-in-depth for the server boundary: nothing arriving from a
    // socket may ever crash the host process, even if a future engine
    // change introduces an accidental throw.
    try {
      const result = game.applyCommand(command as GameCommand);
      if (isReset && !result.ok) roundDeadline = previousDeadline;
      return result;
    } catch {
      if (isReset) roundDeadline = previousDeadline;
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
    // Then the round decision deadline — checked on every tick (manual or
    // loop-driven) so an armed deadline fires deterministically regardless
    // of how the simulation is being driven.
    checkRoundDeadline();
  }

  function tickCount(): number {
    return ticks;
  }

  function roundDeadlineFireAt(): number | null {
    return roundDeadline;
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
    roundDeadline = null; // no armed deadline survives teardown
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
    roundDeadline: roundDeadlineFireAt,
    serializedState,
    onStateChange,
    destroy,
  };
}
