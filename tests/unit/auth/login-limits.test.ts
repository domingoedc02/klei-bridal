import { describe, expect, it } from "vitest";

import { MemoryAttemptStore } from "@/server/ratelimit/attempt-store";
import { clientIp } from "@/server/ratelimit/client-ip";
import {
  ACCOUNT_MAX_FAILURES,
  BACKOFF_CAP_MS,
  IP_MAX_FAILURES,
  WINDOW_MS,
  accountLockedUntil,
  backoffMs,
  clearLoginFailures,
  ipRetryAfterMs,
  recordLoginFailure,
} from "@/server/ratelimit/login";

const MINUTE = 60_000;

function fixture() {
  let t = Date.parse("2026-10-09T00:00:00Z");
  const store = new MemoryAttemptStore(() => t);
  return {
    store,
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("sign-in limits (spec/api: 10/15min/IP, 5/15min/account + backoff)", () => {
  it("backs off 5, 10, 20, then caps at 30 minutes", () => {
    expect([1, 2, 3, 4, 9].map(backoffMs)).toEqual([
      5 * MINUTE,
      10 * MINUTE,
      20 * MINUTE,
      BACKOFF_CAP_MS,
      BACKOFF_CAP_MS,
    ]);
    expect(BACKOFF_CAP_MS).toBe(30 * MINUTE);
  });

  it("locks an account on its 5th failure, whatever IPs they came from", async () => {
    const { store, now } = fixture();
    for (let i = 1; i < ACCOUNT_MAX_FAILURES; i++) {
      expect(await recordLoginFailure(store, `10.0.0.${i}`, "a@x.com", now())).toBeNull();
    }
    const until = await recordLoginFailure(store, "10.0.0.99", "A@X.com ", now());
    expect(until?.getTime()).toBe(now().getTime() + 5 * MINUTE);
    expect(await accountLockedUntil(store, "a@x.com", now())).toEqual(until);
  });

  it("doubles the lock on each successive run of failures, and a success resets it", async () => {
    const { store, now, advance } = fixture();
    const lockAfterRun = async () => {
      let until: Date | null = null;
      for (let i = 0; i < ACCOUNT_MAX_FAILURES; i++) {
        until = await recordLoginFailure(store, "1.1.1.1", "b@x.com", now());
      }
      return until!.getTime() - now().getTime();
    };
    expect(await lockAfterRun()).toBe(5 * MINUTE);
    advance(5 * MINUTE);
    expect(await accountLockedUntil(store, "b@x.com", now())).toBeNull();
    expect(await lockAfterRun()).toBe(10 * MINUTE);
    advance(10 * MINUTE);
    expect(await lockAfterRun()).toBe(20 * MINUTE);
    advance(20 * MINUTE);
    expect(await lockAfterRun()).toBe(30 * MINUTE);

    await clearLoginFailures(store, "b@x.com");
    expect(await accountLockedUntil(store, "b@x.com", now())).toBeNull();
    expect(await lockAfterRun()).toBe(5 * MINUTE);
  });

  it("refuses an IP after 10 failures across any accounts, until the window ends", async () => {
    const { store, now, advance } = fixture();
    for (let i = 0; i < IP_MAX_FAILURES - 1; i++) {
      await recordLoginFailure(store, "9.9.9.9", `u${i}@x.com`, now());
    }
    expect(await ipRetryAfterMs(store, "9.9.9.9")).toBeNull();
    await recordLoginFailure(store, "9.9.9.9", "u9@x.com", now());
    expect(await ipRetryAfterMs(store, "9.9.9.9")).toBe(WINDOW_MS);
    expect(await ipRetryAfterMs(store, "9.9.9.8")).toBeNull();
    advance(WINDOW_MS);
    expect(await ipRetryAfterMs(store, "9.9.9.9")).toBeNull();
  });

  it("forgets failures older than the window", async () => {
    const { store, now, advance } = fixture();
    for (let i = 0; i < ACCOUNT_MAX_FAILURES - 1; i++) {
      await recordLoginFailure(store, "1.1.1.1", "c@x.com", now());
    }
    advance(WINDOW_MS);
    expect(await recordLoginFailure(store, "1.1.1.1", "c@x.com", now())).toBeNull();
  });
});

describe("clientIp", () => {
  it("prefers X-Real-IP, then the LAST X-Forwarded-For hop (the proxy-appended one)", () => {
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
