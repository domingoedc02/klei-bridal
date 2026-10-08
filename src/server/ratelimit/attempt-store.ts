/**
 * The counter primitive sign-in limiting is built on. Its operations are
 * deliberately Valkey's own — INCR + PEXPIRE on first increment, GET,
 * SET PX, DEL, PTTL — because spec/api puts the login counters in Valkey,
 * and the Valkey client arrives with the pipeline's rate-limit step
 * (KBS-11-1). Swapping in a Valkey-backed store is then a new class
 * implementing this interface, not a rewrite of the callers.
 *
 * Any method may throw (Valkey unreachable). Sign-in treats that as
 * "refuse" — login fails CLOSED (spec/api, Idempotency & rate limits).
 */
export interface AttemptStore {
  /** Increments `key`; the first increment starts a `ttlMs` expiry window. */
  incr(key: string, ttlMs: number): Promise<number>;
  get(key: string): Promise<number | null>;
  set(key: string, value: number, ttlMs: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  /** Milliseconds until `key` expires, or null when it does not exist. */
  pttl(key: string): Promise<number | null>;
}

const SWEEP_THRESHOLD = 10_000;

/**
 * In-process store. Correct for this deployment's single Next.js container
 * (spec/architecture); its one weakness against Valkey is that a restart
 * forgets the windows. The account lock itself is ALSO written to
 * `staff_users.locked_until`, so a lock on a real account survives one.
 */
export class MemoryAttemptStore implements AttemptStore {
  private readonly entries = new Map<string, { value: number; expiresAt: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  async incr(key: string, ttlMs: number): Promise<number> {
    const entry = this.live(key);
    if (entry) {
      entry.value += 1;
      return entry.value;
    }
    this.sweep();
    this.entries.set(key, { value: 1, expiresAt: this.clock() + ttlMs });
    return 1;
  }

  async get(key: string): Promise<number | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: number, ttlMs: number): Promise<void> {
    this.sweep();
    this.entries.set(key, { value, expiresAt: this.clock() + ttlMs });
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
  }

  async pttl(key: string): Promise<number | null> {
    const entry = this.live(key);
    return entry ? entry.expiresAt - this.clock() : null;
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  // Bounded memory under a spray of distinct IPs/emails: expired entries
  // are otherwise only dropped when their own key is touched again.
  private sweep() {
    if (this.entries.size < SWEEP_THRESHOLD) return;
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
