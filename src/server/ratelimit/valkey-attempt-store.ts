import type Redis from "iovalkey";
import { getValkeyClient } from "./index";
import type { AttemptStore } from "./attempt-store";

const toNumber = (value: string | null): number | null =>
  value === null ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Sign-in's failed-attempt counters on Valkey (spec/api: login counters live
 * in Valkey), so windows and locks survive an app restart. Any command
 * error propagates; signIn turns it into a fail-CLOSED 503.
 *
 * Takes a client getter so importing this module never opens a connection.
 */
export class ValkeyAttemptStore implements AttemptStore {
  constructor(private readonly getClient: () => Redis) {}

  private get client(): Redis {
    return this.getClient();
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    // One MULTI: the window starts on the first increment only (PEXPIRE NX),
    // and a crash between the two commands cannot leave a key with no TTL.
    const replies = await this.client.multi().incr(key).pexpire(key, ttlMs, "NX").exec();
    const incr = replies?.[0];
    if (!incr || incr[0]) throw incr?.[0] ?? new Error("valkey: empty MULTI reply");
    return Number(incr[1]);
  }

  async get(key: string): Promise<number | null> {
    return toNumber(await this.client.get(key));
  }

  async set(key: string, value: number, ttlMs: number): Promise<void> {
    await this.client.set(key, String(value), "PX", ttlMs);
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys);
  }

  async pttl(key: string): Promise<number | null> {
    const result = await this.client.pttl(key);
    return result < 0 ? null : result;
  }
}

let attemptStore: AttemptStore | undefined;

/** Process-wide store on the same Valkey client as the route rate limits. */
export function getLoginAttemptStore(): AttemptStore {
  attemptStore ??= new ValkeyAttemptStore(getValkeyClient);
  return attemptStore;
}
