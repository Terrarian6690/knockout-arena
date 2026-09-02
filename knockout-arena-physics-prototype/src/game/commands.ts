/**
 * The command model - how player INTENT enters the engine.
 *
 * A command is the only way outside input can affect the simulation. Commands
 * are deliberately intentions ("aim here", "lock in my move"), never
 * outcomes: there is no command to eliminate a pawn, change the phase,
 * resolve a collision, or declare a winner. Those are engine-internal
 * results of simulating, which is what makes a future authoritative server
 * possible - a client can only ask, never decide.
 *
 * ROUNDS ARE SIMULTANEOUS: aim / setPower / confirmLaunch are a player's
 * OWN choices within the CURRENT shared aiming round. confirmLaunch locks
 * that player's choice (it does NOT start movement by itself) - the round's
 * movements begin together only when every alive player has confirmed, or
 * when the server resolves the round (the `resolveRound` command, its
 * decision deadline).
 *
 * OWNERSHIP: every action command identifies the player issuing it. The
 * engine verifies that the player exists and is not eliminated before
 * applying. A future server performs the same check against the
 * authenticated session before even forwarding the command - a player can
 * never submit a command for another player.
 *
 * Commands are plain JSON-serializable objects so a future transport layer
 * can ship them verbatim.
 */

/**
 * Player intentions accepted by the engine. `playerId` refers to the pawn
 * the sender claims to control - it is validated, never trusted.
 */
export type GameCommand =
  /** Aim the sender's pawn toward a world-space point (aiming round only,
   *  before the sender has confirmed). */
  | { type: "aim"; playerId: string; x: number; y: number }
  /** Select the sender's pawn launch power (aiming round only, before the
   *  sender has confirmed); the engine clamps to range. */
  | { type: "setPower"; playerId: string; power: number }
  /**
   * Lock in the sender's move for the CURRENT round (aim + power become
   * immutable for that player). Does NOT start movement by itself: the
   * round resolves when every alive player has confirmed, or when the
   * server resolves it (see resolveRound).
   */
  | { type: "confirmLaunch"; playerId: string }
  /**
   * Resolve the current aiming round with whatever confirmations exist:
   * all confirmed players' movements start together; unconfirmed players
   * do not move this round. This is the server's decision-deadline action
   * (match-level, player-less — exactly like reset). The multiplayer
   * server submits it when the round deadline expires; players cannot.
   */
  | { type: "resolveRound" }
  /**
   * Reset the match to its initial state. Deliberately player-less for now:
   * it is a match-level/debug action. In the multiplayer phase this becomes
   * a privileged room operation (host-only / rematch vote).
   */
  | { type: "reset" };

/**
 * What a UI sends before identity is attached. The client bridge converts
 * intents into full commands by attaching the local player id
 * (see withPlayerId) - exactly where a future network session will attach
 * the authenticated identity. `reset` is a match-level action and passes
 * through unchanged.
 */
export type PlayerIntent =
  | { type: "aim"; x: number; y: number }
  | { type: "setPower"; power: number }
  | { type: "confirmLaunch" }
  | { type: "reset" };

/** Attach a player identity to a UI intent, producing a full command. */
export function withPlayerId(intent: PlayerIntent, playerId: string): GameCommand {
  switch (intent.type) {
    case "aim":
      return { type: "aim", playerId, x: intent.x, y: intent.y };
    case "setPower":
      return { type: "setPower", playerId, power: intent.power };
    case "confirmLaunch":
      return { type: "confirmLaunch", playerId };
    case "reset":
      return { type: "reset" };
  }
}

/**
 * Why a command was not applied.
 *
 *   invalid-command    - structurally malformed (unknown type, missing or
 *                        non-numeric fields, missing playerId). Safe to
 *                        evaluate against completely untrusted input.
 *   unknown-player     - the playerId does not exist in this match.
 *   wrong-player       - the player exists but cannot act: their pawn is
 *                        eliminated.
 *   wrong-phase        - the player is fine, but the phase does not accept
 *                        the command (e.g. choosing while the round is
 *                        still resolving, or anything after the match
 *                        finished).
 *   already-confirmed  - the player already locked in their move for the
 *                        current round; aim/power/confirm are immutable
 *                        until the next round begins.
 */
export type CommandRejection =
  | "invalid-command"
  | "unknown-player"
  | "wrong-player"
  | "wrong-phase"
  | "already-confirmed";

/** Outcome of validating/applying a command. */
export type CommandResult =
  | { ok: true }
  | { ok: false; reason: CommandRejection };

const REJECTED = { ok: false } as const;

/**
 * Structural validation of an arbitrary value as a GameCommand.
 *
 * Pure and total: never throws, never touches game state. Range/phase rules
 * are intentionally NOT checked here - clamping power and phase/turn gating
 * are engine policy (see game.ts applyCommand), so behavior stays identical
 * to the pre-command era.
 */
export function validateCommand(candidate: unknown): CommandResult {
  try {
    return validateCommandInner(candidate);
  } catch {
    // Hostile input (e.g. throwing getters) must never escape the boundary.
    return { ...REJECTED, reason: "invalid-command" };
  }
}

function validateCommandInner(candidate: unknown): CommandResult {
  if (typeof candidate !== "object" || candidate === null) {
    return { ...REJECTED, reason: "invalid-command" };
  }
  const cmd = candidate as Record<string, unknown>;

  // Every action command must identify its sender.
  const hasPlayerId =
    typeof cmd.playerId === "string" && cmd.playerId.length > 0;

  switch (cmd.type) {
    case "aim":
      if (!hasPlayerId || !isFiniteNumber(cmd.x) || !isFiniteNumber(cmd.y)) {
        return { ...REJECTED, reason: "invalid-command" };
      }
      return { ok: true };
    case "setPower":
      // Any finite number is structurally valid; the engine clamps/rounds it.
      if (!hasPlayerId || !isFiniteNumber(cmd.power)) {
        return { ...REJECTED, reason: "invalid-command" };
      }
      return { ok: true };
    case "confirmLaunch":
      if (!hasPlayerId) {
        return { ...REJECTED, reason: "invalid-command" };
      }
      return { ok: true };
    case "resolveRound":
      // Match-level, player-less — structurally valid; ownership is the
      // server's business (players never get to submit it over the wire).
      return { ok: true };
    case "reset":
      return { ok: true };
    default:
      // Unknown command types - including attempts to state authoritative
      // outcomes ("eliminate", "setPhase", "setPosition", ...) - are rejected.
      return { ...REJECTED, reason: "invalid-command" };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
