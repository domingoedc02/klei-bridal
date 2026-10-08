import { hash, verify } from "@node-rs/argon2";
import type { Algorithm } from "@node-rs/argon2";

/**
 * argon2id, tuned for THIS box rather than copied from a documentation
 * example (KBS-27): a 4 vCPU / 8 GB VPS shared with Postgres and `sharp`
 * AVIF encoding (300–600 MB per worker, concurrency 2).
 *
 * - memoryCost 32 MiB — above OWASP's 19 MiB floor, and small enough that
 *   even a burst of concurrent sign-ins from the whole staff costs a few
 *   hundred MB at most, never competing with an encode for the box.
 * - timeCost 3 — measured ~27 ms per verify on an Apple M1; expect roughly
 *   2–3x that on a shared VPS vCPU. `devops` verifies the real number.
 * - parallelism 1 — one libuv thread per verify, so a sign-in never takes
 *   more than one core away from Postgres or the image worker.
 *
 * Parameters live in code, not env (KBS-27 Technical design): changing
 * them is a reviewed decision, and every stored hash carries its own
 * parameters in the PHC string, so old hashes keep verifying.
 */
export const ARGON2_PARAMS = {
  // `Algorithm` is an ambient const enum, which `isolatedModules` cannot
  // read at runtime — 2 is Algorithm.Argon2id.
  algorithm: 2 as Algorithm,
  memoryCost: 32768,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * A real argon2id hash of 32 random bytes nobody kept, with exactly
 * ARGON2_PARAMS (a unit test pins that). Sign-in verifies against it when
 * the email matches no account, so "no such account" costs the same as
 * "wrong password" and response time is not an enumeration oracle.
 * Regenerate it if ARGON2_PARAMS changes.
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=32768,t=3,p=1$Kaimw9SYLeamvw9TE8tjsg$7ha6Xxv0HcRJ5ScXoWyOYYbmtL1Fx5QoERN1qNISLoE";

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS);
}

/** False for a wrong password AND for a malformed stored hash — never throws. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
