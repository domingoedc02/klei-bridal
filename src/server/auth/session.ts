import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";

import { env } from "@/config/env";
import type { Database } from "@/server/db/client";
import { sessions, staffUsers } from "@/server/db/schema";

/**
 * DB-backed staff sessions (KBS-27, spec/security). NOT Auth.js: its
 * Credentials provider forces a JWT, which cannot be revoked server-side,
 * and "disabling a leaver ends their session at once" would quietly be
 * false.
 *
 * The cookie carries 256 random bits; the table stores only their
 * SHA-256. Nothing is signed, so there is no signing secret to manage or
 * leak — a stolen DB or backup yields no replayable cookie, and an
 * attacker cannot mint a valid value without the database.
 *
 * The raw token exists only in the Set-Cookie header and the request's
 * Cookie header. It is never logged, never stored, never returned in a
 * body.
 */
export const SESSION_COOKIE = "kbs_session";

/** Absolute lifetime of a session row from sign-in. KBS-27-2 adds the idle timeout. */
export const SESSION_ABSOLUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// 32 bytes → 43 base64url characters, no padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function mintSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * `HttpOnly; Secure; SameSite=Lax; Path=/`, host-only (no Domain).
 * Lax, not Strict: Strict would drop the cookie when staff follow a link
 * into admin from an email or chat; admin has no cross-site POST that
 * would need None. `Secure` is off only under `next dev`, which serves
 * plain http://localhost (Safari drops Secure cookies there).
 */
export function sessionCookieOptions(expiresAt: Date, now: Date = new Date()) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV !== "development",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
  };
}

/** Expires the cookie in the browser. Revoke the row FIRST (see revokeSession). */
export function clearedSessionCookieOptions() {
  return { ...sessionCookieOptions(new Date(0), new Date(0)), maxAge: 0 };
}

/** `db` itself, or the handle inside `db.transaction(...)`. */
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface NewSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/** Every sign-in gets a NEW row and a NEW token — a session id is never reused. */
export async function createSession(
  db: DbOrTx,
  input: { staffUserId: string; ip: string | null; userAgent: string | null; now?: Date },
): Promise<NewSession> {
  const now = input.now ?? new Date();
  const token = mintSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS);

  const [row] = await db
    .insert(sessions)
    .values({
      staffUserId: input.staffUserId,
      tokenHash: hashSessionToken(token),
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
    })
    .returning({ id: sessions.id });

  if (!row) throw new Error("session insert returned no row");
  return { token, sessionId: row.id, expiresAt };
}

export interface ValidSession {
  sessionId: string;
  expiresAt: Date;
  staff: { id: string; name: string; email: string };
}

/**
 * The per-request lookup (spec/security):
 *
 *   token_hash = sha256(cookie) AND revoked_at IS NULL
 *     AND expires_at > now() AND staff_user.is_active = true
 *
 * The `is_active` join is what makes disabling an account take effect on
 * that person's very next request. Any miss returns null — the caller
 * answers 401 without saying which condition failed.
 */
export async function validateSession(
  db: Database,
  token: string | undefined | null,
  now: Date = new Date(),
): Promise<ValidSession | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      staffId: staffUsers.id,
      name: staffUsers.name,
      email: staffUsers.email,
    })
    .from(sessions)
    .innerJoin(staffUsers, eq(staffUsers.id, sessions.staffUserId))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        eq(staffUsers.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    sessionId: row.sessionId,
    expiresAt: row.expiresAt,
    staff: { id: row.staffId, name: row.name, email: row.email },
  };
}

/**
 * Sets `revoked_at` on the row the token names, if it is still live.
 * Sign-out calls this BEFORE clearing the cookie, so a copied cookie stops
 * working even if the browser never receives the clearing response.
 */
export async function revokeSession(
  db: Database,
  token: string | undefined | null,
  now: Date = new Date(),
): Promise<boolean> {
  if (!token || !TOKEN_PATTERN.test(token)) return false;
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length > 0;
}
