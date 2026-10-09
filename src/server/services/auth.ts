import { eq, sql } from "drizzle-orm";

import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "@/server/auth/password";
import {
  assertPasswordAllowed,
  MIN_PASSWORD_LENGTH as POLICY_MIN_PASSWORD_LENGTH,
} from "@/server/auth/password-policy";
import {
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
  rotateSession,
  validateSession,
} from "@/server/auth/session";
import { db as defaultDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import { auditLog, staffUsers } from "@/server/db/schema";
import type { AttemptStore } from "@/server/ratelimit/attempt-store";
import { inetOrNull } from "@/server/ratelimit/client-ip";
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

  // `staff_users.locked_until` is trusted only while Valkey ALSO holds the
  // lock. Valkey locks any email, account or not; the row exists only for
  // real accounts — so honouring the row alone (e.g. after Valkey lost its
  // keys) would lock real accounts but not unknown emails: an enumeration
  // oracle. The row still supplies the later end when both exist.
  const dbLock = storeLock && user?.lockedUntil && user.lockedUntil > now ? user.lockedUntil : null;
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
      // Durable copy of the lock, for an admin screen to show and clear.
      // It never locks on its own (see dbLock above).
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
      ip: inetOrNull(input.ip),
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
  ip: string | null = null,
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
      ip: inetOrNull(ip),
      entityType: "staff_user",
      entityId: session.staff.id,
      detail: { session_id: session.sessionId },
    });
  }
}

/** spec/security: a new or reset password is at least 12 characters. */
export const MIN_PASSWORD_LENGTH = POLICY_MIN_PASSWORD_LENGTH;

export type ChangePasswordResult =
  | { ok: true; token: string; expiresAt: Date; revokedOtherSessions: number }
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "wrong_current_password" }
  | { ok: false; reason: "too_many_attempts"; retryAfterSeconds: number }
  | { ok: false; reason: "weak_password" | "password_too_common" | "unavailable" };

// ponytail: fixed limits (KBS-63), not env — same as sign-in. Per USER, not
// per IP, so rotating IPs or sessions never buys more guesses.
export const PASSWORD_CHANGE_MAX_FAILURES = 5;
const PASSWORD_CHANGE_WINDOW_MS = 15 * 60_000;
const pwchgKey = (staffUserId: string) => `pwchg:fail:${staffUserId}`;

async function retryAfterSeconds(store: AttemptStore, key: string): Promise<number> {
  const ms = await store.pttl(key);
  return ms && ms > 0 ? Math.ceil(ms / 1000) : PASSWORD_CHANGE_WINDOW_MS / 1000;
}

/**
 * Password change from settings (current + new), KBS-27-2. In ONE
 * transaction: store the new hash, revoke every OTHER session of the
 * account (a session an attacker holds cannot outlive the password), and
 * rotate the session that made the change — its old token is revoked and
 * a new one issued, so a copy of the pre-change cookie is dead too.
 */
export async function changePassword(
  input: {
    token: string | undefined | null;
    currentPassword: string;
    newPassword: string;
    ip: string | null;
    userAgent: string | null;
  },
  deps: Pick<AuthDeps, "db" | "now"> & { store?: AttemptStore } = defaultDeps,
): Promise<ChangePasswordResult> {
  const { db } = deps;
  const store = deps.store ?? loginAttemptStore;
  const now = deps.now?.() ?? new Date();

  const session = await validateSession(db, input.token, now);
  if (!session) return { ok: false, reason: "unauthenticated" };

  // KBS-63: wrong current-password guesses are capped per user. While the
  // counter is at the limit, EVERY session of the user is refused before
  // the password is verified, so a right guess can't be confirmed. A store
  // outage fails closed (503) and nothing changes.
  const key = pwchgKey(session.staff.id);
  try {
    if (((await store.get(key)) ?? 0) >= PASSWORD_CHANGE_MAX_FAILURES) {
      return {
        ok: false,
        reason: "too_many_attempts",
        retryAfterSeconds: await retryAfterSeconds(store, key),
      };
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const [user] = await db
    .select({ passwordHash: staffUsers.passwordHash })
    .from(staffUsers)
    .where(eq(staffUsers.id, session.staff.id))
    .limit(1);
  if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    let failures: number;
    let retry: number;
    try {
      failures = await store.incr(key, PASSWORD_CHANGE_WINDOW_MS);
      retry = failures >= PASSWORD_CHANGE_MAX_FAILURES ? await retryAfterSeconds(store, key) : 0;
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (failures < PASSWORD_CHANGE_MAX_FAILURES)
      return { ok: false, reason: "wrong_current_password" };
    // The session that tripped the limit is revoked: a stolen cookie gets
    // no more tries once the window ends.
    await db.transaction(async (tx) => {
      await revokeSession(tx, input.token, now);
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: session.staff.id,
        action: "auth.password_change_locked",
        ip: inetOrNull(input.ip),
        entityType: "staff_user",
        entityId: session.staff.id,
        detail: { session_id: session.sessionId, failures },
      });
    });
    return { ok: false, reason: "too_many_attempts", retryAfterSeconds: retry };
  }
  const policy = await assertPasswordAllowed(input.newPassword, { email: session.staff.email });
  if (!policy.ok) return { ok: false, reason: policy.reason };
  try {
    await store.del([key]);
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const passwordHash = await hashPassword(input.newPassword);
  return db.transaction(async (tx) => {
    await tx
      .update(staffUsers)
      .set({ passwordHash, updatedAt: now })
      .where(eq(staffUsers.id, session.staff.id));
    const revokedOtherSessions = await revokeAllSessionsForUser(tx, session.staff.id, now, {
      exceptSessionId: session.sessionId,
    });
    const rotated = await rotateSession(tx, {
      sessionId: session.sessionId,
      staffUserId: session.staff.id,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: session.staff.id,
      action: "staff.password_change",
      ip: inetOrNull(input.ip),
      entityType: "staff_user",
      entityId: session.staff.id,
      detail: { revoked_sessions: revokedOtherSessions, session_id: rotated.sessionId },
    });
    return {
      ok: true as const,
      token: rotated.token,
      expiresAt: rotated.expiresAt,
      revokedOtherSessions,
    };
  });
}

/**
 * Password reset — the staff-admin reset (`PATCH /admin/staff/:id
 * {password}`) and, later, the emailed-token confirm step both end here.
 * Every session of the account is revoked: whoever reset it signs in
 * again with the new password.
 */
export async function resetPassword(
  input: {
    staffUserId: string;
    newPassword: string;
    actorUserId: string | null;
    ip?: string | null;
  },
  deps: Pick<AuthDeps, "db" | "now"> = defaultDeps,
): Promise<
  | { ok: true; revokedSessions: number }
  | { ok: false; reason: "weak_password" | "password_too_common" | "unavailable" }
> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const [staff] = await db
    .select({ email: staffUsers.email })
    .from(staffUsers)
    .where(eq(staffUsers.id, input.staffUserId))
    .limit(1);
  const policy = await assertPasswordAllowed(input.newPassword, { email: staff?.email });
  if (!policy.ok) return { ok: false, reason: policy.reason };
  const passwordHash = await hashPassword(input.newPassword);
  const revokedSessions = await db.transaction(async (tx) => {
    await tx
      .update(staffUsers)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(staffUsers.id, input.staffUserId));
    const revoked = await revokeAllSessionsForUser(tx, input.staffUserId, now);
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: input.actorUserId,
      action: "staff.password_reset",
      ip: inetOrNull(input.ip),
      entityType: "staff_user",
      entityId: input.staffUserId,
      detail: { revoked_sessions: revoked },
    });
    return revoked;
  });
  return { ok: true, revokedSessions };
}

/**
 * Disable or re-enable a staff account (KBS-24 calls this). Disabling is
 * effective on the person's very next request through the `is_active`
 * join in validateSession (AC-ADM-27); the rows are revoked as well, in
 * the same transaction, so re-enabling never revives a leaver's old
 * cookies. Accounts are never deleted (audit trail).
 */
export async function setStaffActive(
  input: { staffUserId: string; isActive: boolean; actorUserId: string | null; ip?: string | null },
  deps: Pick<AuthDeps, "db" | "now"> = defaultDeps,
): Promise<{ revokedSessions: number }> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  return db.transaction(async (tx) => {
    await tx
      .update(staffUsers)
      .set({ isActive: input.isActive, updatedAt: now })
      .where(eq(staffUsers.id, input.staffUserId));
    const revokedSessions = input.isActive
      ? 0
      : await revokeAllSessionsForUser(tx, input.staffUserId, now);
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: input.actorUserId,
      action: input.isActive ? "staff.enable" : "staff.disable",
      ip: inetOrNull(input.ip),
      entityType: "staff_user",
      entityId: input.staffUserId,
      detail: { revoked_sessions: revokedSessions },
    });
    return { revokedSessions };
  });
}

/** "Sign out everywhere" in settings: every session of the caller's account. */
export async function signOutEverywhere(
  token: string | undefined | null,
  ip: string | null = null,
  deps: Pick<AuthDeps, "db" | "now"> = defaultDeps,
): Promise<boolean> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const session = await validateSession(db, token, now);
  if (!session) return false;
  await db.transaction(async (tx) => {
    const revoked = await revokeAllSessionsForUser(tx, session.staff.id, now);
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: session.staff.id,
      action: "staff.sign_out_everywhere",
      ip: inetOrNull(ip),
      entityType: "staff_user",
      entityId: session.staff.id,
      detail: { revoked_sessions: revoked },
    });
  });
  return true;
}
