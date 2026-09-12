import Matter from "matter-js";
import { CONFIG } from "./config";
import { createPhysicsWorld, type PhysicsWorld } from "./physics";
import {
  spawnPositionForSlot,
  isPawnOutOfBounds,
  initialArenaRadius,
  clampArenaRadius,
  shrinkDueAfterRound,
  shrunkArenaRadius,
} from "./arena";
import { createPlayer, type Player } from "./player";
import { createAimState, aimAt, launchVelocity } from "./aiming";
import { createRoundState, checkSettled, type RoundState } from "./roundLogic";
import type { GameStateSnapshot } from "./types";
import { validateCommand, type CommandRejection, type CommandResult, type GameCommand } from "./commands";
import {
  validateGameState,
  type GameState,
  type PawnState,
} from "./state";
import { projectSnapshot } from "./project";

/**
 * Core game engine (orchestrator) — the authoritative simulation.
 *
 * Owns the game state, round logic, and physics for ANY number of players
 * (single-player is simply a one-player match). It exposes:
 *   - applyCommand(command) — validate + apply a player INTENT
 *   - update(dtMs) — advance one frame (called from a RAF or a server loop)
 *   - getState()/loadState() — full serializable state (reconstruction I/O)
 *   - snapshot() — client-facing spectator projection for rendering
 *   - subscribe(listener) — raw authoritative state notifications
 *
 * SIMULTANEOUS ROUNDS — there is no turn queue and no current player:
 *
 *   - every alive player independently sends aim / setPower /
 *     confirmLaunch during the shared aiming phase;
 *   - confirmLaunch LOCKS that player's choice (aim + power become
 *     immutable for the round) but does NOT start movement by itself;
 *   - when EVERY alive player has confirmed — or when the server submits
 *     the match-level `resolveRound` command (its decision deadline) —
 *     all confirmed movements start together in ONE transition and the
 *     physics resolves them simultaneously (collisions between movers
 *     included). Unconfirmed players do not move that round: their pawns
 *     simply stay where they are;
 *   - when every survivor has settled, eliminations are final and a NEW
 *     aiming round begins for all remaining alive players;
 *   - the match ends by the elimination rule alone (≤1 alive), exactly
 *     as before.
 *
 * SHRINKING ARENA — authoritative, deterministic, between rounds only:
 *
 *   - the playable radius is match state (GameState.arena.radius), not a
 *     constant: it starts at CONFIG.arena.radius and drops by
 *     CONFIG.arena.shrink.amount every CONFIG.arena.shrink.everyRounds
 *     COMPLETED rounds, never below CONFIG.arena.shrink.minRadius;
 *   - the shrink is applied at exactly ONE point — resolveRoundEnd, after
 *     all movement has settled and before the next aiming round opens —
 *     so it can never alter a round that is already resolving, and the
 *     schedule is pure arithmetic on a counter (no clock, no randomness:
 *     every client/server replay of the same states shrinks identically);
 *   - shrinking moves the LOGICAL elimination boundary only. No wall or
 *     barrier is ever created (the world still holds pawn bodies only),
 *     so pawns keep leaving the arena freely;
 *   - a pawn left outside the NEW boundary is eliminated by the engine
 *     the moment the shrink lands — the same geometric rule, applied
 *     immediately rather than waiting for the next tick.
 *
 * The countdown/warning players see is DERIVED from this state
 * (arena.ts#arenaShrinkView) — clients never count rounds themselves.
 *
 * MATCH TIME LIMIT — a hard 4-minute cap (CONFIG.match.durationMs):
 *
 *   - the engine has NO clock. The server owns the deadline (gameHost)
 *     and submits the match-level `timeUp` command when it fires, which
 *     is the only way the limit reaches the simulation;
 *   - `timeUp` ends the match through the ordinary finishMatch path into
 *     the existing "finished" phase — never a new phase;
 *   - the winner is the last pawn standing, or, with several still
 *     alive, the survivor closest to the arena center (ties → roster
 *     order). See finishByTimeLimit;
 *   - it is rejected once the match is finished, so a match that ended
 *     naturally before the limit can never be finished a second time.
 *
 * Intended ownership model for the multiplayer server:
 *
 *   receive command → validateCommand → applyCommand → update (fixed ticks)
 *   → getState → serializeGameState → send to clients
 *
 * The engine never accepts outcomes from outside: elimination, phase
 * transitions, collisions and settling are computed here and only here. It
 * also has NO notion of a "local" player — every command names the player
 * that issued it (validated against the roster), and projection to a
 * local perspective is the caller's job (see projectSnapshot). Clients (the
 * React bridge in the UI layer) send commands and render projections.
 *
 * It deliberately does NOT know about React, canvas, or networking — and,
 * beyond the round phase itself, nothing about connections either: a
 * disconnected player is simply an unconfirmed one until they reconnect
 * or the server resolves the round.
 *
 * Simulation timing: `update` receives real frame time and exchanges it for
 * fixed `CONFIG.simulation.fixedTimestepMs` ticks via an accumulator, so the
 * physics behaves identically regardless of display refresh rate. All
 * per-tick decisions (elimination, settling) happen inside those fixed ticks.
 */

/** Description of one participant when creating a match. */
export interface PlayerSpec {
  /** Unique pawn id within the match (e.g. "p0", "p1"). */
  id: string;
  /** Display name. */
  name: string;
  /** Palette index; defaults to the player's seat index. */
  colorIndex?: number;
}

/** Options for createGame. */
export interface GameOptions {
  /** Participants; defaults to a single local-style player "p0". */
  players?: PlayerSpec[];
}

export interface GameHandle {
  /**
   * Validate and apply a player command. Returns acceptance or a
   * machine-readable rejection reason — a future server can forward this
   * verbatim as the command acknowledgement. The command's playerId is
   * verified against the roster and the elimination state; client-supplied
   * ids are never trusted beyond that check.
   */
  applyCommand(command: GameCommand): CommandResult;
  /**
   * Legacy alias of applyCommand that discards the result. Kept for the
   * React client bridge and existing call sites; new code should prefer
   * applyCommand.
   */
  dispatch(action: GameCommand): void;
  /** Advance the game by one animation frame (fixed-tick accumulator). */
  update(dtMs: number): void;
  /**
   * Client-facing SPECTATOR projection of the authoritative state (no local
   * perspective). Call projectSnapshot(state, id) for a localized view.
   */
  snapshot(): GameStateSnapshot;
  /** Full serializable authoritative state (see state.ts). */
  getState(): GameState;
  /**
   * Replace the entire game state. The input is validated (trust boundary):
   * a future server may feed this with state received from storage or a
   * peer process. Rebuilding from state does not change simulation rules.
   */
  loadState(state: GameState): void;
  /**
   * Subscribe to the raw authoritative GameState (server-ready). The engine
   * pushes the current state immediately; every later change re-emits.
   * Rendering clients project it themselves (see projectSnapshot).
   */
  subscribe(listener: (state: GameState) => void): () => void;
  destroy(): void;
}

const DEFAULT_PLAYERS: PlayerSpec[] = [
  { id: "p0", name: "Player 1", colorIndex: 0 },
];

export function createGame(options?: GameOptions): GameHandle {
  const specs = options?.players ?? DEFAULT_PLAYERS;
  if (specs.length === 0) {
    throw new Error("createGame: at least one player is required");
  }
  const seenIds = new Set<string>();
  for (const spec of specs) {
    if (typeof spec.id !== "string" || spec.id.length === 0) {
      throw new Error("createGame: player ids must be non-empty strings");
    }
    if (seenIds.has(spec.id)) {
      throw new Error(`createGame: duplicate player id ${spec.id}`);
    }
    seenIds.add(spec.id);
  }

  const physics: PhysicsWorld = createPhysicsWorld();
  /**
   * The arena the whole engine measures against. Its `radius` is MUTABLE
   * match state (the shrinking arena): every geometry consumer —
   * elimination, settling, spawning — reads this one object, so a shrink
   * is applied in exactly one place and can never leave two radii
   * disagreeing. `roundsSinceShrink` is the schedule's only counter.
   */
  const arena = physics.arena;
  let roundsSinceShrink = 0;

  // Deterministic spawns on the arena's FIXED slot ring (arena.ts):
  // seat i always occupies slot i, whatever the turnout, so a match with
  // fewer than CONFIG.match.maxPlayers players leaves the unused slots
  // as empty gaps instead of re-spacing everyone. The slot order keeps
  // small matches spread out (seats 0 and 1 are diametrically opposed).
  const players: Player[] = specs.map((spec, i) => {
    const [spawnX, spawnY] = spawnPositionForSlot(arena, i);
    return createPlayer({
      id: spec.id,
      name: spec.name,
      colorIndex: spec.colorIndex ?? i,
      spawnX,
      spawnY,
    });
  });

  // Map player id -> physics body.
  const bodies = new Map<string, Matter.Body>();
  for (const p of players) {
    bodies.set(p.id, physics.createPawnBody(p.id, p.spawnX, p.spawnY, p.radius));
  }

  /** Per-pawn round selection state (mirrored into the authoritative state). */
  const confirmed = new Map<string, boolean>();
  for (const p of players) confirmed.set(p.id, false);

  const round: RoundState = createRoundState();
  /** Winner pawn id once finished (null while running / no survivor). */
  let winner: string | null = null;

  let listeners: ((s: GameState) => void)[] = [];

  const FIXED_DT = CONFIG.simulation.fixedTimestepMs;
  let accumulator = 0;

  function emit() {
    const s = getState();
    for (const l of listeners) l(s);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Match lifecycle: elimination, finishing, round resolution
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Knock a pawn out: flag it, freeze it and turn it into a non-collidable
   * ghost. The body stays in the world (rendered where it left the arena,
   * part of the historical state) but neither blocks nor is pushed by
   * anyone. Elimination is NOT a phase: the match continues while two or
   * more pawns remain active.
   */
  function eliminatePawn(player: Player, body: Matter.Body) {
    player.eliminated = true;
    confirmed.set(player.id, false); // an eliminated pawn participates in nothing
    physics.stop(body);
    physics.setGhost(body, true);
  }

  /**
   * End the match. `winnerId` is the last pawn standing, or null when
   * nobody survived (e.g. a single-player loss). Remaining pawns are brought
   * to their canonical resting state so the terminal state is stable and
   * serializes cleanly.
   */
  function finishMatch(winnerId: string | null) {
    winner = winnerId;
    setPhase("finished");
    for (const p of players) {
      if (p.eliminated) continue;
      confirmed.set(p.id, false);
      const body = bodies.get(p.id);
      if (body) physics.settleOnFloor(body, p.radius);
    }
  }

  /**
   * THE MATCH TIME LIMIT expired (the server's `timeUp` command).
   *
   * A hard stop: the match ends immediately, in whatever phase it was —
   * mid-aiming, mid-flight, or between rounds. It always ends through
   * the ordinary finishMatch path into the existing "finished" phase, so
   * winner handling, settling and serialization are exactly what every
   * other ending produces. No new phase, no special case downstream.
   *
   * THE VERDICT (deterministic, from authoritative state only):
   *   - nobody alive        → no winner (null), like any other wipeout;
   *   - exactly one alive   → that player wins, the ordinary rule;
   *   - several alive       → TIE-BREAK: the survivor CLOSEST TO THE
   *     ARENA CENTER wins. It reads only authoritative positions, it
   *     needs no new state, and it is the natural fit for a shrinking
   *     arena (holding the center is exactly what the match rewards).
   *     Exact distance ties fall back to ROSTER ORDER (seat order, p0
   *     first) — the same stable order everything else in the engine
   *     uses — so the outcome never depends on iteration accidents,
   *     floating-point noise or who reconnected when.
   *
   * Pure arithmetic on the current state: replaying the same state on
   * any machine yields the same winner.
   */
  function finishByTimeLimit() {
    const alive = players.filter((p) => !p.eliminated);
    if (alive.length === 0) {
      finishMatch(null);
      return;
    }
    let best = alive[0];
    let bestDistSq = distanceToCenterSq(best);
    for (const p of alive.slice(1)) {
      const d = distanceToCenterSq(p);
      // Strict <: an exact tie keeps the earlier pawn, i.e. roster order.
      if (d < bestDistSq) {
        best = p;
        bestDistSq = d;
      }
    }
    finishMatch(best.id);
  }

  /** Squared distance from a pawn's CURRENT position to the arena center. */
  function distanceToCenterSq(player: Player): number {
    const body = bodies.get(player.id);
    const pos = body
      ? physics.position(body)
      : { x: player.spawnX, y: player.spawnY };
    const dx = pos.x - arena.centerX;
    const dy = pos.y - arena.centerY;
    return dx * dx + dy * dy;
  }

  /**
   * Begin the CURRENT round's movement phase. Every alive player whose
   * choice is confirmed gets their launch impulse applied in this ONE
   * synchronous transition — no physics step happens in between, so all
   * confirmed movements start together and the simulation resolves them
   * simultaneously. Unconfirmed players receive no impulse and simply stay
   * where they are.
   */
  function beginRoundMovement() {
    for (const p of players) {
      if (p.eliminated || !confirmed.get(p.id)) continue;
      const body = bodies.get(p.id);
      if (!body) continue;
      // A confirmed player without an explicit aim launches along the
      // default direction — the same rule the sequential model had.
      const dir = p.aim.active ? p.aim.direction : { x: 0, y: -1 };
      const vel = launchVelocity(dir, p.power);
      physics.applyImpulse(body, vel.x, vel.y);
      p.aim.active = false; // the aim was consumed by this launch
      // THE REVEAL: the committed launch becomes part of the authoritative
      // state the moment movements begin. Until this exact moment the aim
      // was private (only its owner's projection carried it); from here on
      // it is public fact, projected to every viewer for the movement
      // phase — including a disconnected-but-confirmed player's launch.
      p.lastLaunch = { direction: { x: dir.x, y: dir.y }, power: p.power };
    }
    round.settleTicks = 0;
    accumulator = 0;
    setPhase("moving");
  }

  /** Has every alive player locked in their move for this round? */
  function allAliveConfirmed(): boolean {
    const alive = players.filter((p) => !p.eliminated);
    return alive.length > 0 && alive.every((p) => confirmed.get(p.id));
  }

  /**
   * Advance the shrink schedule by one COMPLETED round and apply the
   * shrink when it is due. Called from exactly one place
   * (resolveRoundEnd), which is what makes "between rounds, never mid
   * round" structural rather than a convention: all movement has
   * settled, and the next aiming round has not opened yet.
   *
   * Shrinking is purely a change of the LOGICAL boundary — no body, no
   * barrier, nothing physical is created. Pawns the smaller arena leaves
   * outside are eliminated right here by the ordinary geometric rule, so
   * the state a player sees is always self-consistent: everyone still
   * alive is inside the current arena.
   *
   * Deterministic: a counter plus config arithmetic. No wall clock, no
   * randomness, identical on every machine and after any state transfer.
   */
  function advanceShrinkSchedule() {
    roundsSinceShrink += 1;
    if (!shrinkDueAfterRound(roundsSinceShrink)) return;
    roundsSinceShrink = 0;

    const next = shrunkArenaRadius(arena.radius);
    if (next === arena.radius) return; // at the minimum: nothing shrinks

    arena.radius = next;

    // The new boundary applies IMMEDIATELY: whoever the smaller floor
    // left behind is out, by the very same geometric rule the tick loop
    // uses. This does not re-run or alter the finished round's movement —
    // it judges the positions that round already produced.
    for (const p of players) {
      if (p.eliminated) continue;
      const body = bodies.get(p.id);
      if (!body) continue;
      const pos = physics.position(body);
      if (isPawnOutOfBounds(arena, pos.x, pos.y, p.radius)) {
        eliminatePawn(p, body);
      }
    }
    // NOTHING else is touched. Survivors keep the exact positions the
    // round left them in — the shrink judges the finished round's
    // outcome, it never rewrites it (no re-simulation, no nudging pawns
    // inward). A survivor may therefore legitimately straddle the new
    // edge: still touching the floor is still alive, by the same rule as
    // everywhere else.
  }

  /**
   * Resolve the end of a round (all movement settled). The shrink
   * schedule advances FIRST — the round is over, so its shrink (and any
   * elimination the smaller arena causes) must be part of the verdict
   * this round produces. Then either the match finishes — fewer than two
   * pawns remain in a multi-pawn roster — or a NEW simultaneous aiming
   * round begins: confirmations reset (aim indicators too; power
   * selections are kept as each player's standing choice), and every
   * remaining alive player chooses again.
   */
  function resolveRoundEnd() {
    advanceShrinkSchedule();

    const alive = players.filter((p) => !p.eliminated);
    if (players.length >= 2 && alive.length === 1) {
      finishMatch(alive[0].id);
      return;
    }
    if (alive.length === 0) {
      // Every pawn is gone (normally caught during ticks; safety net).
      finishMatch(null);
      return;
    }
    startNextRound();
  }

  /** Open a fresh simultaneous aiming round for all alive players. */
  function startNextRound() {
    for (const p of players) {
      if (p.eliminated) continue;
      confirmed.set(p.id, false);
      p.aim.active = false; // a new round means a fresh aim; power is kept
    }
    // The previous round's committed launches stop being revealed the
    // moment a new aiming round opens — for EVERY pawn (eliminated ones
    // included): a fresh round must show no stale launch arrows.
    for (const p of players) {
      p.lastLaunch = null;
    }
    round.settleTicks = 0;
    setPhase("aiming");
  }

  // ────────────────────────────────────────────────────────────────────────
  // Authoritative state I/O (serialization boundary)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Collect the complete authoritative state as plain, JSON-serializable
   * data. Matter.js bodies are read through the physics facade and reduced
   * to kinematics; no engine internals leak out. Per-pawn aim + power +
   * round confirmation are part of the state, so a server can apply each
   * player's commands to the correct pawn after reconstruction.
   */
  function getState(): GameState {
    return {
      phase: round.phase,
      winnerId: winner,
      round: {
        settleTicks: round.settleTicks,
      },
      // The shrinking arena: the current radius plus the schedule's
      // counter. Everything a client needs to draw the right arena and
      // show the right warning is derived from these two numbers.
      arena: {
        radius: arena.radius,
        roundsSinceShrink,
      },
      pawns: players.map((p): PawnState => {
        const body = bodies.get(p.id);
        const k = body
          ? physics.bodyState(body)
          : {
              position: { x: p.spawnX, y: p.spawnY },
              velocity: { x: 0, y: 0 },
              angle: 0,
              angularVelocity: 0,
            };
        return {
          id: p.id,
          name: p.name,
          colorIndex: p.colorIndex,
          radius: p.radius,
          spawnX: p.spawnX,
          spawnY: p.spawnY,
          eliminated: p.eliminated,
          power: p.power,
          aim: {
            active: p.aim.active,
            direction: { ...p.aim.direction },
          },
          confirmed: confirmed.get(p.id) ?? false,
          lastLaunch:
            p.lastLaunch === null
              ? null
              : {
                  direction: { ...p.lastLaunch.direction },
                  power: p.lastLaunch.power,
                },
          position: { ...k.position },
          velocity: {
            x: k.velocity.x,
            y: k.velocity.y,
          },
          angle: k.angle,
          angularVelocity: k.angularVelocity,
        };
      }),
    };
  }

  /**
   * Replace the entire state. Bodies are reused where pawn ids match and
   * created/removed otherwise, so the engine is fully state-driven — a
   * future server can boot a match from a deserialized N-player state.
   * Eliminated pawns are restored as ghosts; alive pawns collide with
   * other pawns (there is no wall state to restore).
   *
   * The state is then NORMALIZED against the match rules — defensively, and
   * without changing how a locally simulated match would continue:
   *   - with no pawn left the match ends immediately with no winner (the
   *     tick loop would reach the same verdict on the next step);
   *   - a live "aiming" state must be runnable: with a single survivor in a
   *     multi-pawn roster that pawn has won, and a state in which every
   *     alive player is already confirmed is transient by construction, so
   *     the round's movement begins right away;
   *   - "moving" states are left to resolve naturally: the round ends when
   *     every survivor settles, exactly like an uninterrupted simulation
   *     (an eliminated mover mid-flight is legal — the flight still belongs
   *     to that round).
   */
  function loadState(next: GameState) {
    const s = validateGameState(next); // throws on malformed input

    const wanted = new Map(s.pawns.map((p) => [p.id, p]));
    for (const [id, body] of bodies) {
      if (!wanted.has(id)) {
        physics.removePawnBody(body);
        bodies.delete(id);
      }
    }

    players.length = 0;
    confirmed.clear();
    for (const p of s.pawns) {
      let body = bodies.get(p.id);
      if (!body) {
        body = physics.createPawnBody(p.id, p.position.x, p.position.y, p.radius);
        bodies.set(p.id, body);
      }
      physics.setBodyState(body, {
        position: { x: p.position.x, y: p.position.y },
        velocity: { x: p.velocity.x, y: p.velocity.y },
        angle: p.angle,
        angularVelocity: p.angularVelocity,
      });
      // Eliminated pawns come back as ghosts; alive pawns collide with
      // other pawns (there is no wall state to restore).
      physics.setGhost(body, p.eliminated);
      players.push({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        radius: p.radius,
        spawnX: p.spawnX,
        spawnY: p.spawnY,
        eliminated: p.eliminated,
        power: p.power,
        aim: {
          active: p.aim.active,
          direction: { ...p.aim.direction },
        },
        // Absent (older serialized states) reads as "no committed launch".
        lastLaunch: p.lastLaunch ? { ...p.lastLaunch } : null,
      });
      confirmed.set(p.id, p.eliminated ? false : p.confirmed);
    }

    winner = s.winnerId;
    round.settleTicks = s.round.settleTicks;
    // The shrinking arena travels with the state, so a reconnecting
    // client, a restored match or a peer process continues at exactly the
    // authoritative size and schedule position. ABSENT (a state from
    // before the mechanic) reads as a fresh full-size arena; the radius
    // is clamped to the legal range as a trust boundary.
    arena.radius = clampArenaRadius(s.arena?.radius ?? initialArenaRadius());
    roundsSinceShrink = Math.max(0, Math.trunc(s.arena?.roundsSinceShrink ?? 0));
    setPhase(s.phase);
    accumulator = 0;

    // Normalization (see above).
    const alive = players.filter((p) => !p.eliminated);
    if (alive.length === 0) {
      finishMatch(null);
    } else if (round.phase === "aiming") {
      if (players.length >= 2 && alive.length === 1) {
        finishMatch(alive[0].id);
      } else if (alive.every((p) => confirmed.get(p.id))) {
        beginRoundMovement(); // transient state — resolve it like the engine would
      }
    }
    // phase "moving": let the tick loop resolve the round naturally.

    emit();
  }

  /** Spectator projection of the authoritative state (no local player). */
  function snapshot(): GameStateSnapshot {
    return projectSnapshot(getState(), null);
  }

  function setPhase(next: GameState["phase"]) {
    round.phase = next;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Command handling (player intentions)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Participation gate for action commands: the sender must be a known
   * player who is still in the match. Rejection precedence: unknown-player
   * → wrong-phase (match finished) → wrong-player (eliminated); the caller
   * additionally checks the round rules (aiming phase, not yet confirmed).
   * A player can never act for another player — the command names its
   * sender and the engine applies it to exactly that pawn. A future server
   * performs this same check after authenticating the session that owns
   * playerId — client pawn ids are never trusted.
   */
  function participationGate(
    playerId: string
  ): { ok: true; player: Player } | { ok: false; reason: CommandRejection } {
    const player = players.find((p) => p.id === playerId);
    if (!player) {
      return { ok: false, reason: "unknown-player" };
    }
    if (round.phase === "finished") {
      return { ok: false, reason: "wrong-phase" };
    }
    if (player.eliminated) {
      return { ok: false, reason: "wrong-player" };
    }
    return { ok: true, player };
  }

  function onAim(player: Player, x: number, y: number) {
    const body = bodies.get(player.id);
    if (!body) return;
    const pos = physics.position(body);
    const dir = aimAt({ x: pos.x, y: pos.y }, { x, y });
    if (dir) {
      player.aim.direction = dir;
      player.aim.active = true;
    }
  }

  function onSetPower(player: Player, value: number) {
    player.power = Math.max(
      CONFIG.power.min,
      Math.min(CONFIG.power.max, Math.round(value))
    );
  }

  /**
   * Lock in the sender's move for the current round. The choice becomes
   * immutable (aim/setPower/confirmLaunch are rejected with
   * already-confirmed until the next round). Movement starts here ONLY if
   * this was the last missing confirmation of ALL alive players — and it
   * then starts for everyone confirmed, together.
   */
  function onConfirm(player: Player) {
    confirmed.set(player.id, true);
    if (allAliveConfirmed()) {
      beginRoundMovement();
    }
  }

  function onReset() {
    // A fresh match starts in a FULL-SIZE arena with the shrink schedule
    // back at zero — restored BEFORE the pawns, so they return to spawn
    // points computed for the full floor rather than the shrunken one.
    arena.radius = initialArenaRadius();
    roundsSinceShrink = 0;
    for (const p of players) {
      const body = bodies.get(p.id);
      if (body) {
        // Reposition the body to spawn, zero velocity, restore collisions.
        Matter.Body.setPosition(body, { x: p.spawnX, y: p.spawnY });
        physics.stop(body);
        physics.setGhost(body, false);
      }
      p.eliminated = false;
      p.power = CONFIG.power.default;
      p.aim = createAimState();
      p.lastLaunch = null; // a fresh match reveals nothing
      confirmed.set(p.id, false);
    }
    round.settleTicks = 0;
    winner = null;
    accumulator = 0;
    setPhase("aiming");
    emit();
  }

  /**
   * Validate and apply a command. Structural validation is total (untrusted
   * input safe); participation + phase + round gating mirror the engine
   * rules and yield machine-readable rejections instead of silent no-ops,
   * so a future server can acknowledge commands precisely.
   */
  function applyCommand(command: GameCommand): CommandResult {
    const validation = validateCommand(command);
    if (!validation.ok) return validation;

    switch (command.type) {
      case "aim": {
        const gate = participationGate(command.playerId);
        if (!gate.ok) return gate;
        if (round.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        if (confirmed.get(gate.player.id)) {
          return { ok: false, reason: "already-confirmed" };
        }
        onAim(gate.player, command.x, command.y);
        emit();
        return { ok: true };
      }
      case "setPower": {
        const gate = participationGate(command.playerId);
        if (!gate.ok) return gate;
        if (round.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        if (confirmed.get(gate.player.id)) {
          return { ok: false, reason: "already-confirmed" };
        }
        onSetPower(gate.player, command.power);
        emit();
        return { ok: true };
      }
      case "confirmLaunch": {
        const gate = participationGate(command.playerId);
        if (!gate.ok) return gate;
        if (round.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        if (confirmed.get(gate.player.id)) {
          return { ok: false, reason: "already-confirmed" };
        }
        onConfirm(gate.player); // emits below
        emit();
        return { ok: true };
      }
      case "resolveRound": {
        // Match-level: the server's decision-deadline action. Players never
        // reach this through the multiplayer wire (the room manager
        // rejects it as unauthorized); solo/local callers may use it for
        // testing the round model.
        if (round.phase !== "aiming") return { ok: false, reason: "wrong-phase" };
        beginRoundMovement(); // emits below
        emit();
        return { ok: true };
      }
      case "timeUp": {
        // Match-level: the server's match time limit. Players never reach
        // this through the multiplayer wire (the room manager rejects it
        // as unauthorized); solo/local callers may use it for testing.
        //
        // IDEMPOTENT BY PHASE: an already-finished match is never
        // finished twice — a natural winner decided before the limit
        // stands, and a late/duplicate timeUp is rejected rather than
        // re-running the verdict or re-emitting a finish.
        if (round.phase === "finished") {
          return { ok: false, reason: "wrong-phase" };
        }
        finishByTimeLimit();
        emit();
        return { ok: true };
      }
      case "reset":
        onReset(); // accepted in every phase; emits
        return { ok: true };
    }
  }

  /** Legacy alias for the client bridge — result discarded. */
  function dispatch(action: GameCommand) {
    applyCommand(action);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Simulation
  // ────────────────────────────────────────────────────────────────────────

  /**
   * One fixed simulation tick.
   *
   * 1. Step the physics by the fixed delta — ALL moving pawns (this round's
   *    confirmed movers and anyone they shove) advance together. There is
   *    no rim decision to make: the arena has no physical wall, so pawns
   *    glide straight off the floor at any speed. Knocking another pawn
   *    off the floor is the core mechanic.
   * 2. Elimination pass — pure arena geometry, checked for EVERY alive
   *    pawn. Several pawns can leave the floor on the same tick. When no
   *    pawn survives, the match ends immediately with no winner.
   * 3. Settle: the round resolves when every remaining pawn has come to
   *    rest (or the timeout fires) — shoved opponents must stop gliding
   *    too before the next round begins. Every pawn is then brought to its
   *    canonical resting state (see physics.settleOnFloor): stopped AND
   *    projected back onto the floor if it ended past the floor edge, so a
   *    settled state serializes and reconstructs deterministically.
   */
  function tickSimulation() {
    physics.step(FIXED_DT);
    round.settleTicks += 1;

    for (const p of players) {
      if (p.eliminated) continue;
      const body = bodies.get(p.id);
      if (!body) continue;
      const posAfter = physics.position(body);
      if (isPawnOutOfBounds(arena, posAfter.x, posAfter.y, p.radius)) {
        eliminatePawn(p, body);
      }
    }
    if (!players.some((p) => !p.eliminated)) {
      finishMatch(null); // everybody is out — immediate end, no survivor
      return;
    }

    const alive = players.filter((p) => !p.eliminated);
    const allSettled = alive.every((p) => {
      const body = bodies.get(p.id);
      if (!body) return true;
      const v = physics.velocity(body);
      return checkSettled(Math.hypot(v.x, v.y), round.settleTicks).settled;
    });
    if (allSettled) {
      for (const p of alive) {
        const body = bodies.get(p.id);
        if (body) physics.settleOnFloor(body, p.radius);
      }
      resolveRoundEnd();
    }
  }

  /**
   * Advance the game by one animation frame. Frame time is converted into
   * fixed simulation ticks; large frame gaps (tab switches, GC pauses) are
   * clamped so the loop never tries to catch up in a spiral. When nothing is
   * moving this is a cheap no-op — no physics, no state emission.
   */
  function update(dtMs: number) {
    if (round.phase !== "moving") {
      accumulator = 0;
      return;
    }

    accumulator += Math.min(dtMs, CONFIG.simulation.maxFrameMs);
    let stepped = false;
    while (accumulator >= FIXED_DT && round.phase === "moving") {
      accumulator -= FIXED_DT;
      tickSimulation();
      stepped = true;
    }
    if (!stepped) return;
    if (round.phase !== "moving") accumulator = 0;
    emit();
  }

  function subscribe(listener: (state: GameState) => void) {
    // Push the current state immediately so a freshly mounted UI (e.g. the
    // React app) never has to wait for the next event to render something.
    listener(getState());
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  function destroy() {
    listeners = [];
    physics.destroy();
  }

  // Emit initial state.
  emit();

  return {
    applyCommand,
    dispatch,
    update,
    snapshot,
    getState,
    loadState,
    subscribe,
    destroy,
  };
}
