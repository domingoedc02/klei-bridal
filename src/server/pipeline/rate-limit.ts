import type { Budget } from "../ratelimit/budgets";
import type { RateLimitStore } from "../ratelimit/store";
import { PipelineError, SilentlyDropped } from "./errors";

/** Seconds a fail-closed outage asks the client to wait before retrying. */
export const OUTAGE_RETRY_AFTER_SEC = 30;

export function rateLimitKey(budget: Budget, id: string): string {
  return `rl:${budget.name}:${budget.dimension}:${id}`;
}

/**
 * Counts one hit against `budget` for `id` (spec/architecture step 5).
 *
 * Over the limit: 429 with `Retry-After` = the window's remaining TTL, or —
 * for the channel beacon only — a silent 204 that never surfaces to the bride.
 *
 * Valkey unreachable: fail-CLOSED budgets (enquiry submit, send-my-list,
 * login) answer 503 + `Retry-After`, so an outage never hands an attacker
 * unlimited attempts; fail-OPEN budgets let the request through.
 *
 * Exported so the login handler can apply `budgets.loginAccount` once it
 * knows which account was named.
 */
export async function enforceRateLimit(
  budget: Budget,
  id: string,
  store: RateLimitStore,
): Promise<void> {
  let hit: { count: number; ttlSec: number };
  try {
    hit = await store.hit(rateLimitKey(budget, id), budget.windowSec);
  } catch (error) {
    if (budget.failMode === "open") return;
    throw new PipelineError(
      503,
      "SERVICE_UNAVAILABLE",
      "This is temporarily unavailable. Please try again shortly.",
      { retryAfterSec: OUTAGE_RETRY_AFTER_SEC, detail: `rate limiter unreachable`, cause: error },
    );
  }

  if (hit.count <= budget.limit) return;
  if (budget.onExceeded === "silent-204") throw new SilentlyDropped();
  throw new PipelineError(429, "RATE_LIMITED", "Too many requests. Please try again later.", {
    retryAfterSec: hit.ttlSec > 0 ? hit.ttlSec : budget.windowSec,
  });
}
