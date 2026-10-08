import { eq, sql } from "drizzle-orm";

import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/server/auth/password";
import { createSession, revokeSession, validateSession } from "@/server/auth/session";
import { db as defaultDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import { auditLog, staffUsers } from "@/server/db/schema";
import type { AttemptStore } from "@/server/ratelimit/attempt-store";
import {
  accountLockedUntil,
  clearLoginFailures,
  ipRetryAfterMs,
  loginAttemptStore,
  normaliseEmail,
  recordLoginFailure,
} from "@/server/ratelimit/login";

export interface AuthDeps {
  db: Database;
  store: AttemptStore;
  now?: () => Date;
}

const defaultDeps: AuthDeps = { db: defaultDb, store: loginAttemptStore };

export type SignInResult =
  | {
      ok: true;
      token: string;
      expiresAt: Date;
      staff: { id: string; name: string; email: string };
    }
  /** Unknown email, wrong password and disabled account all land here, identically. */
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "ip_rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: "account_locked"; retryAfterSeconds: number }
  /** The attempt store is unreachable — login fails CLOSED (spec/api). */
  | { ok: false; reason: "unavailable"; retryAfterSeconds: number };

const UNAVAILABLE_RETRY_SECONDS = 30;

function secondsUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/**
 * Sign-in, in this order (KBS-27-1):
 *
 *  1. IP limit (10 failures / 15 min) — refused before any work.
 *  2. Account lock — the email's backoff lock, or `staff_users.locked_until`.
 *     A locked attempt is refused EVEN WITH THE RIGHT PASSWORD (AC-ADM-29)
 *     and never reaches argon2, so it is not a guess.
 *  3. Exactly ONE argon2id verify, always: against the account's hash, or
 *     against DUMMY_PASSWORD_HASH when the email has no account or the
 *     account is disabled. Unknown email, wrong password and disabled
 *     account then cost the same time and return the same result.
 *  4. Success: clear the counters and mint a brand-new session row.
 */
export async function signIn(
  input: { email: string; password: string; ip: string; userAgent: string | null },
  deps: AuthDeps = defaultDeps,
): Promise<SignInResult> {
  const { db, store } = deps;
  const now = deps.now?.() ?? new Date();
  const email = normaliseEmail(input.email);

  let storeLock: Date | null;
  try {
    const ipRetryMs = await ipRetryAfterMs(store, input.ip);
    if (ipRetryMs !== null) {
      return {
        ok: false,
        reason: "ip_rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil(ipRetryMs / 1000)),
      };
    }
    storeLock = await accountLockedUntil(store, email, now);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
  }

  const [user] = await db
    .select()
    .from(staffUsers)
    .where(eq(sql`lower(${staffUsers.email})`, email))
    .limit(1);

  const dbLock = user?.lockedUntil && user.lockedUntil > now ? user.lockedUntil : null;
  const lock = [storeLock, dbLock].reduce<Date | null>(
    (latest, d) => (d && (!latest || d > latest) ? d : latest),
    null,
  );
  if (lock) {
    return { ok: false, reason: "account_locked", retryAfterSeconds: secondsUntil(lock, now) };
  }

  const usable = user?.isActive ? user : undefined;
  const passwordOk = await verifyPassword(
    usable?.passwordHash ?? DUMMY_PASSWORD_HASH,
    input.password,
  );

  if (!usable || !passwordOk) {
    let newLock: Date | null;
    try {
      newLock = await recordLoginFailure(store, input.ip, email, now);
    } catch {
      return { ok: false, reason: "unavailable", retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
    }
    if (user) {
      // Durable copy of the lock: it survives a restart of the in-process
      // store, and is what an admin screen can show and clear.
      await db
        .update(staffUsers)
        .set({
          failedLoginCount: sql`${staffUsers.failedLoginCount} + 1`,
          ...(newLock ? { lockedUntil: newLock } : {}),
          updatedAt: now,
        })
        .where(eq(staffUsers.id, user.id));
    }
    return { ok: false, reason: "invalid_credentials" };
  }

  try {
    await clearLoginFailures(store, email);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS };
  }

  const session = await db.transaction(async (tx) => {
    await tx
      .update(staffUsers)
      .set({ failedLoginCount: 0, lockedUntil: null, lastSignInAt: now, updatedAt: now })
      .where(eq(staffUsers.id, usable.id));
    const created = await createSession(tx, {
      staffUserId: usable.id,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: usable.id,
      action: "staff.sign_in",
      entityType: "staff_user",
      entityId: usable.id,
      detail: { session_id: created.sessionId },
    });
    return created;
  });

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    staff: { id: usable.id, name: usable.name, email: usable.email },
  };
}

/**
 * Sign-out revokes the row, then (in the route) clears the cookie — never
 * the cookie alone, or a copied cookie would keep working until expiry.
 * Idempotent: an absent, unknown or already-revoked token is not an error.
 */
export async function signOut(
  token: string | undefined | null,
  deps: Pick<AuthDeps, "db" | "now"> = defaultDeps,
): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const session = await validateSession(db, token, now);
  const revoked = await revokeSession(db, token, now);
  if (revoked && session) {
    await db.insert(auditLog).values({
      occurredAt: now,
      actorUserId: session.staff.id,
      action: "staff.sign_out",
      entityType: "staff_user",
      entityId: session.staff.id,
      detail: { session_id: session.sessionId },
    });
  }
}
