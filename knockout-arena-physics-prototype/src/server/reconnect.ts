import { createHash, randomBytes } from "node:crypto";

/**
 * Reconnect credentials — the server-issued, per-seat recovery tokens.
 *
 * When a session takes a seat (create_room / join_room) the server issues
 * an opaque credential that is returned ONLY to that player (in their
 * personal welcome message — never in broadcasts, rosters, snapshots or
 * any shared state). If their connection drops, the seat is reserved for
 * a configurable window; presenting the credential on a new connection
 * reclaims the SAME seat (same session identity, same playerId).
 *
 * Trust model (interim, like session tokens — real auth is future work):
 *
 *   - credentials are 256-bit cryptographically random values — opaque,
 *     not derived from playerId, roomId or the session token, and
 *     unguessable in practice;
 *   - only credentials issued by this process resolve to seats;
 *   - lookup is hash-then-map: the registry stores SHA-256 digests, never
 *     the raw values, and the Map probes fixed-length digests — no
 *     early-exit string comparison on secret material;
 *   - the raw credential is untrusted input: anything that is not a
 *     non-empty string, or whose digest is unknown, resolves to nothing.
 *     The caller cannot choose a seat, a room or a playerId — the
 *     credential resolves to exactly the one seat it was issued for.
 *
 * No networking, no rooms, no gameplay — a pure registry.
 */

/** What a valid credential resolves to (server-internal only). */
export interface ReconnectCredential {
  /** The session token whose seat the credential recovers. */
  readonly sessionToken: string;
  readonly roomId: string;
  readonly playerId: string;
}

export interface ReconnectRegistry {
  /** Issue a fresh credential for a seated session; returns the raw token. */
  issue(sessionToken: string, roomId: string, playerId: string): string;
  /** Resolve untrusted input to its credential, or null. */
  resolve(rawToken: unknown): ReconnectCredential | null;
  /** Revoke whatever credential a session currently holds (leave/expire). */
  revokeSession(sessionToken: string): void;
  /** Revoke everything (server teardown). */
  clear(): void;
  /** Number of live credentials (observability/tests). */
  size(): number;
}

function digestOf(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function createReconnectRegistry(): ReconnectRegistry {
  /** sha256(raw credential) → credential record. */
  const byDigest = new Map<string, ReconnectCredential>();
  /** session token → sha256 of its current credential (one seat per session). */
  const bySession = new Map<string, string>();

  function issue(
    sessionToken: string,
    roomId: string,
    playerId: string
  ): string {
    // A session re-seating (leave + create/join again) replaces its old
    // credential — the previous one must stop working.
    revokeSession(sessionToken);
    const rawToken = randomBytes(32).toString("base64url");
    const key = digestOf(rawToken);
    const record: ReconnectCredential = { sessionToken, roomId, playerId };
    byDigest.set(key, record);
    bySession.set(sessionToken, key);
    return rawToken;
  }

  function resolve(rawToken: unknown): ReconnectCredential | null {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    return byDigest.get(digestOf(rawToken)) ?? null;
  }

  function revokeSession(sessionToken: string): void {
    const key = bySession.get(sessionToken);
    if (key === undefined) return;
    bySession.delete(sessionToken);
    const record = byDigest.get(key);
    // Only delete the digest if it still belongs to this session (a
    // re-issued credential for the same session replaced the map entry).
    if (record && record.sessionToken === sessionToken) {
      byDigest.delete(key);
    }
  }

  function clear(): void {
    byDigest.clear();
    bySession.clear();
  }

  function size(): number {
    return byDigest.size;
  }

  return { issue, resolve, revokeSession, clear, size };
}
