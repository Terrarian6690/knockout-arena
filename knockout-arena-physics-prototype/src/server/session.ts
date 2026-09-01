import { randomUUID } from "node:crypto";

/**
 * Server-side connection/session identity — the root of the trust chain.
 *
 * The authoritative identity chain is:
 *
 *   connection/session  →  server-assigned playerId  →  room membership
 *                       →  GameHost.submitCommand(playerId, command)
 *
 * A Session is issued by the server on connect() and is NEVER derived from
 * anything a client sends. The client never picks a playerId: the server
 * resolves the session to its seat (see roomManager.ts) and stamps that
 * playerId onto every command the session submits.
 *
 * Interim trust model (real authentication is deliberately not implemented
 * yet): the opaque token IS the credential. Tokens are unguessable
 * (random UUIDs) and only tokens issued by this process resolve to seats,
 * so a forged session object with a made-up token is rejected. Token theft
 * is an authentication concern for the future auth layer.
 */
export interface Session {
  /** Opaque, unguessable, server-generated connection token. */
  readonly token: string;
  /** Wall-clock connection time (observability only; never gameplay data). */
  readonly connectedAt: number;
}

/** Issue a fresh session. Called by the server facade on connect. */
export function createSession(): Session {
  return { token: randomUUID(), connectedAt: Date.now() };
}

/**
 * Structural guard for the trust boundary: is this shaped like a Session?
 * Passing it only means the candidate may be looked up in the session
 * registry — an unknown token still resolves to nothing.
 */
export function isSession(candidate: unknown): candidate is Session {
  if (typeof candidate !== "object" || candidate === null) return false;
  const token = (candidate as { token?: unknown }).token;
  return typeof token === "string" && token.length > 0;
}
