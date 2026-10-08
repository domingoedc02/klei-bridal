import { randomUUID } from "node:crypto";
import Redis from "iovalkey";
import { afterAll, describe, expect, it } from "vitest";

import { ValkeyAttemptStore } from "@/server/ratelimit/valkey-attempt-store";
import { valkeyOptions } from "@/server/ratelimit/store";
import { MemoryAttemptStore } from "@/server/ratelimit/attempt-store";
import { accountLockedUntil, recordLoginFailure } from "@/server/ratelimit/login";

// KBS-11-1 (security-eng review on PR #13): sign-in counters on real Valkey 8.

const client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", valkeyOptions);
const store = new ValkeyAttemptStore(() => client);
const key = () => `login:test:${randomUUID()}`;

afterAll(async () => {
  await client.quit();
});

describe("ValkeyAttemptStore", () => {
  it("starts the window on the first INCR only, in milliseconds", async () => {
    const k = key();
    expect(await store.incr(k, 60_000)).toBe(1);
    const first = await store.pttl(k);
    expect(first).toBeGreaterThan(59_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(await store.incr(k, 60_000)).toBe(2);
    expect(await store.pttl(k)).toBeLessThan(first!);
  });

  it("gets, sets with PX, deletes, and reports a missing key as null", async () => {
    const k = key();
    expect(await store.get(k)).toBeNull();
    expect(await store.pttl(k)).toBeNull();
    await store.set(k, 1_234_567, 5_000);
    expect(await store.get(k)).toBe(1_234_567);
    expect(await store.pttl(k)).toBeLessThanOrEqual(5_000);
    await store.del([k]);
    expect(await store.get(k)).toBeNull();
    await store.del([]);
  });

  it("behaves like MemoryAttemptStore for a lockout run", async () => {
    const email = `${randomUUID()}@kleibridal.test`;
    const now = new Date();
    for (const s of [store, new MemoryAttemptStore()]) {
      let lock: Date | null = null;
      for (let i = 0; i < 5; i++) lock = await recordLoginFailure(s, `ip-${i}`, email, now);
      expect(lock).not.toBeNull();
      expect((await accountLockedUntil(s, email, now))?.getTime()).toBe(lock!.getTime());
    }
  });

  it("throws when Valkey is unreachable, so sign-in fails closed", async () => {
    const dead = new Redis("redis://127.0.0.1:1", {
      ...valkeyOptions,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    dead.on("error", () => {});
    await expect(new ValkeyAttemptStore(() => dead).get("k")).rejects.toThrow();
    dead.disconnect();
  });
});
