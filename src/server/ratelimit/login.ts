import { MemoryAttemptStore } from "./attempt-store";
import type { AttemptStore } from "./attempt-store";

const MINUTE = 60_000;

/**
 * Sign-in limits (spec/api, Idempotency & rate limits): failed attempts
 * only — a staff member signing in successfully never spends budget.
 *
 * - per IP: 10 failures / 15 min, then refused until the window ends.
 * - per account: 5 failures / 15 min, then LOCKED with exponential backoff
 *   (5, 10, 20, capped at 30 min). Keyed on the normalised email, NOT the
 *   account id, so an email with no account locks exactly like one with
 *   an account — a lockout message that only real accounts could earn
 *   would be an enumeration oracle of its own.
 */
export const IP_MAX_FAILURES = 10;
export const ACCOUNT_MAX_FAILURES = 5;
export const WINDOW_MS = 15 * MINUTE;
export const BACKOFF_BASE_MS = 5 * MINUTE;
export const BACKOFF_CAP_MS = 30 * MINUTE;
// How long an email's backoff level outlives its last lock. A successful
// sign-in clears it at once.
const LEVEL_TTL_MS = 24 * 60 * MINUTE;

/** Process-wide store until KBS-11-1 lands the Valkey client (see AttemptStore). */
export const loginAttemptStore: AttemptStore = new MemoryAttemptStore();

export function backoffMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (level - 1), BACKOFF_CAP_MS);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const ipKey = (ip: string) => `login:ip:${ip}`;
const acct = (email: string) => `login:acct:${normaliseEmail(email)}`;

/** Milliseconds until `ip` may try again, or null when it is under the limit. */
export async function ipRetryAfterMs(store: AttemptStore, ip: string): Promise<number | null> {
  const failures = await store.get(ipKey(ip));
  if (failures === null || failures < IP_MAX_FAILURES) return null;
  return (await store.pttl(ipKey(ip))) ?? WINDOW_MS;
}

/** When the email is locked, the moment the lock ends; otherwise null. */
export async function accountLockedUntil(
  store: AttemptStore,
  email: string,
  now: Date,
): Promise<Date | null> {
  const until = await store.get(`${acct(email)}:lock`);
  return until !== null && until > now.getTime() ? new Date(until) : null;
}

/**
 * Counts one failed attempt against the IP and the email. The email's
 * fifth failure inside a window locks it for the next backoff step and
 * starts a fresh window, so every further lock takes another full run of
 * failures and lasts twice as long. Returns the new lock's end, or null.
 */
export async function recordLoginFailure(
  store: AttemptStore,
  ip: string,
  email: string,
  now: Date,
): Promise<Date | null> {
  await store.incr(ipKey(ip), WINDOW_MS);

  const key = acct(email);
  const failures = await store.incr(`${key}:fail`, WINDOW_MS);
  if (failures < ACCOUNT_MAX_FAILURES) return null;

  const level = await store.incr(`${key}:level`, LEVEL_TTL_MS);
  const duration = backoffMs(level);
  const until = now.getTime() + duration;
  await store.set(`${key}:lock`, until, duration);
  await store.del([`${key}:fail`]);
  return new Date(until);
}

/** A successful sign-in clears the email's window, backoff level and lock. */
export async function clearLoginFailures(store: AttemptStore, email: string): Promise<void> {
  const key = acct(email);
  await store.del([`${key}:fail`, `${key}:level`, `${key}:lock`]);
}
