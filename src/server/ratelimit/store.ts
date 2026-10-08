import type Redis from "iovalkey";
import type { RedisOptions } from "iovalkey";

export interface RateLimitStore {
  /** Count one hit in a fixed window; resolves the count so far and seconds left. */
  hit(key: string, windowSec: number): Promise<{ count: number; ttlSec: number }>;
}

/**
 * Short timeouts so an outage resolves to fail-open/fail-closed within
 * ~0.5s instead of hanging the request. Commands issued while disconnected
 * wait in the offline queue at most `commandTimeout`, then reject.
 */
export const valkeyOptions: RedisOptions = {
  connectTimeout: 1000,
  commandTimeout: 500,
  maxRetriesPerRequest: 1,
};

export function createValkeyStore(client: Redis): RateLimitStore {
  return {
    async hit(key, windowSec) {
      const replies = await client.multi().incr(key).expire(key, windowSec, "NX").ttl(key).exec();
      const incr = replies?.[0];
      const ttl = replies?.[2];
      if (!incr || incr[0] || !ttl || ttl[0]) {
        throw incr?.[0] ?? ttl?.[0] ?? new Error("valkey: empty MULTI reply");
      }
      return { count: Number(incr[1]), ttlSec: Number(ttl[1]) };
    },
  };
}
