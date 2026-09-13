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
 * EXPIRY TOMBSTONES (Task 14). When a reservation window closes, the
 * credential's DIGEST is moved to a short-lived tombstone set so the
 * server can tell that one specific bearer "your seat was released"
 * instead of the generic rejection. This does not weaken the uniform
 * rejection property:
 *
 *   - a tombstone is only ever created for a credential THIS server
 *     issued and then expired — never for arbitrary input;
 *   - it is keyed by the same SHA-256 digest, so hitting one requires
 *     possessing (or guessing) the original 256-bit random token, which
 *     is exactly as hard as guessing a live credential. A guessed token
 *     misses both maps and gets the generic answer, as before;
 *   - it stores NO seat, room or session data — only the fact that a
 *     digest expired, plus when;
 *   - it is bounded in BOTH time (ttlMs) and size (maxEntries, oldest
 *     evicted first), so it never becomes a permanent record of every
 *     credential ever issued. Once it lapses the answer reverts to the
 *     generic rejection.
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
  /**
   * Revoke a session's credential BECAUSE its reservation window closed,
   * leaving a short-lived tombstone so that bearer — and only that
   * bearer — can be told the seat was released. Use revokeSession() for
   * every other revocation (leave, force disconnect, stale credential):
   * those must stay indistinguishable from never-issued.
   */
  expireSession(sessionToken: string): void;
  /**
   * Whether this exact raw credential was issued by this server and then
   * expired, within the tombstone's lifetime. False for everything else,
   * including guessed tokens and lapsed tombstones.
   */
  wasExpired(rawToken: unknown): boolean;
  /** Revoke everything (server teardown). */
  clear(): void;
  /** Number of live credentials (observability/tests). */
  size(): number;
  /** Number of live tombstones (observability/tests). */
  expiredSize(): number;
}

/** How long a bearer can still learn that their own seat was released. */
export const DEFAULT_EXPIRED_CREDENTIAL_TTL_MS = 5 * 60_000;

/** Hard cap on tombstones, so the set can never grow without bound. */
export const DEFAULT_MAX_EXPIRED_CREDENTIALS = 1024;

export interface ReconnectRegistryOptions {
  /** Tombstone lifetime; after it, the generic rejection returns. */
  expiredTtlMs?: number;
  /** Maximum tombstones retained (oldest evicted first). */
  maxExpiredEntries?: number;
}

function digestOf(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function createReconnectRegistry(
  options: ReconnectRegistryOptions = {}
): ReconnectRegistry {
  /** sha256(raw credential) → credential record. */
  const byDigest = new Map<string, ReconnectCredential>();
  /** session token → sha256 of its current credential (one seat per session). */
  const bySession = new Map<string, string>();
  /**
   * sha256(raw credential) → when its reservation expired. Deliberately
   * holds no seat/room/session data: it answers exactly one question,
   * "did THIS credential expire recently?", for the bearer that already
   * possesses the token.
   */
  const expiredAt = new Map<string, number>();

  const ttlMs = options.expiredTtlMs ?? DEFAULT_EXPIRED_CREDENTIAL_TTL_MS;
  const maxExpired = options.maxExpiredEntries ?? DEFAULT_MAX_EXPIRED_CREDENTIALS;

  /** Drop lapsed tombstones (called on every read/write — no timers). */
  function pruneExpired(now: number): void {
    for (const [digest, at] of expiredAt) {
      if (now - at >= ttlMs) expiredAt.delete(digest);
    }
  }

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

  function expireSession(sessionToken: string): void {
    // Capture the digest BEFORE revoking — revokeSession forgets it.
    const digest = bySession.get(sessionToken);
    const record = digest === undefined ? undefined : byDigest.get(digest);
    revokeSession(sessionToken);
    // Only tombstone a credential that really belonged to this session.
    if (digest === undefined || record?.sessionToken !== sessionToken) return;

    const now = Date.now();
    pruneExpired(now);
    // Bounded: evict the oldest insertion once full (Map preserves
    // insertion order), so the set cannot grow without limit.
    while (expiredAt.size >= maxExpired) {
      const oldest = expiredAt.keys().next();
      if (oldest.done === true) break;
      expiredAt.delete(oldest.value);
    }
    expiredAt.set(digest, now);
  }

  function wasExpired(rawToken: unknown): boolean {
    if (typeof rawToken !== "string" || rawToken.length === 0) return false;
    const now = Date.now();
    pruneExpired(now);
    const at = expiredAt.get(digestOf(rawToken));
    return at !== undefined && now - at < ttlMs;
  }

  function clear(): void {
    byDigest.clear();
    bySession.clear();
    expiredAt.clear();
  }

  function size(): number {
    return byDigest.size;
  }

  function expiredSize(): number {
    pruneExpired(Date.now());
    return expiredAt.size;
  }

  return {
    issue,
    resolve,
    revokeSession,
    expireSession,
    wasExpired,
    clear,
    size,
    expiredSize,
  };
}
