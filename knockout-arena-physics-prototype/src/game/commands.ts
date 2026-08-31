/**
 * The command model — how player INTENT enters the engine.
 *
 * A command is the only way outside input can affect the simulation. Commands
 * are deliberately intentions ("aim here", "launch now"), never outcomes:
 * there is no command to eliminate a pawn, change the phase, resolve a
 * collision, or declare a winner. Those are engine-internal results of
 * simulating, which is what makes a future authoritative server possible —
 * a client can only ask, never decide.
 *
 * Commands are plain JSON-serializable objects so a future transport layer
 * can ship them verbatim.
 */

/** Player intentions accepted by the engine. */
export type GameCommand =
  /** Aim toward a world-space point (only meaningful in the aiming phase). */
  | { type: "aim"; x: number; y: number }
  /** Select a launch power level; the engine clamps to the configured range. */
  | { type: "setPower"; power: number }
  /** Launch the active pawn along the current aim (one launch per turn). */
  | { type: "confirmLaunch" }
  /** Reset the match to its initial state. */
  | { type: "reset" };

/**
 * Why a command was not applied.
 *
 *   invalid-command — structurally malformed (unknown type, missing or
 *                     non-numeric fields). Safe to evaluate against
 *                     completely untrusted input.
 *   wrong-phase     — a well-formed command that the current phase does not
 *                     accept (e.g. launching while a pawn is still moving).
 */
export type CommandRejection = "invalid-command" | "wrong-phase";

/** Outcome of validating/applying a command. */
export type CommandResult =
  | { ok: true }
  | { ok: false; reason: CommandRejection };

const REJECTED = { ok: false } as const;

/**
 * Structural validation of an arbitrary value as a GameCommand.
 *
 * Pure and total: never throws, never touches game state. Range/phase rules
 * are intentionally NOT checked here — clamping power and phase gating are
 * engine policy (see game.ts applyCommand), so behavior stays identical to
 * the pre-command era.
 */
export function validateCommand(candidate: unknown): CommandResult {
  try {
    return validateCommandInner(candidate);
  } catch {
    // Hostile input (e.g. throwing getters) must never escape the boundary.
    return { ok: false, reason: "invalid-command" };
  }
}

function validateCommandInner(candidate: unknown): CommandResult {
  if (typeof candidate !== "object" || candidate === null) {
    return { ...REJECTED, reason: "invalid-command" };
  }
  const cmd = candidate as Record<string, unknown>;

  switch (cmd.type) {
    case "aim":
      if (!isFiniteNumber(cmd.x) || !isFiniteNumber(cmd.y)) {
        return { ...REJECTED, reason: "invalid-command" };
      }
      return { ok: true };
    case "setPower":
      // Any finite number is structurally valid; the engine clamps/rounds it.
      if (!isFiniteNumber(cmd.power)) {
        return { ...REJECTED, reason: "invalid-command" };
      }
      return { ok: true };
    case "confirmLaunch":
    case "reset":
      return { ok: true };
    default:
      // Unknown command types — including attempts to state authoritative
      // outcomes ("eliminate", "setPhase", "setPosition", …) — are rejected.
      return { ...REJECTED, reason: "invalid-command" };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
