import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { env } from "@/config/env";
import { assertPasswordAllowed } from "@/server/auth/password-policy";
import { hashPassword } from "@/server/auth/password";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import { passwordChangedEmail } from "@/server/mail/templates/password-changed";
import { db as defaultDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import { auditLog, passwordResetTokens, staffUsers } from "@/server/db/schema";
import { sendTransactionalEmail } from "@/server/mail/send";

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 30 * 60_000;
const RESET_PATH = "/admin/reset-password";

export interface PasswordResetRequestDeps {
  db: Database;
  now?: () => Date;
  sendEmail?: typeof sendTransactionalEmail;
}

const defaultDeps: PasswordResetRequestDeps = { db: defaultDb };

export const PASSWORD_RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MS;

export type ConfirmPasswordResetResult =
  | { ok: true; revokedSessions: number }
  | {
      ok: false;
      reason: "invalid_token" | "weak_password" | "password_too_common" | "unavailable";
    };

export interface PasswordResetConfirmationDeps {
  db: Database;
  now?: () => Date;
  sendEmail?: typeof sendTransactionalEmail;
}

const defaultConfirmationDeps: PasswordResetConfirmationDeps = { db: defaultDb };

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(RESET_TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashPasswordResetToken(raw) };
}

function resetUrl(rawToken: string): string {
  return `${env.SITE_URL}${RESET_PATH}?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Always returns the same public result. Unknown and disabled addresses do
 * not reveal account state; only active accounts get a token row and mail.
 * Token persistence and revocation commit before mail dispatch starts.
 */
export async function requestPasswordReset(
  input: { email: string },
  deps: PasswordResetRequestDeps = defaultDeps,
): Promise<{ accepted: true }> {
  const now = deps.now?.() ?? new Date();
  const email = input.email.trim().toLowerCase();
  const token = newToken();

  const recipient = await deps.db.transaction(async (tx) => {
    // One query for all account states: unknown, disabled and active requests
    // take the same lookup path. Disabled accounts never receive a token.
    const [active] = await tx
      .select({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email })
      .from(staffUsers)
      .where(and(eq(sql`lower(${staffUsers.email})`, email), eq(staffUsers.isActive, true)))
      .limit(1);
    if (!active) return null;

    // Serialize reset issuance per staff row. This prevents two concurrent
    // requests from leaving two live tokens after both read the same state.
    await tx.update(staffUsers).set({ updatedAt: now }).where(eq(staffUsers.id, active.id));
    await tx
      .update(passwordResetTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passwordResetTokens.staffUserId, active.id),
          isNull(passwordResetTokens.usedAt),
          isNull(passwordResetTokens.revokedAt),
        ),
      );
    await tx.insert(passwordResetTokens).values({
      staffUserId: active.id,
      tokenHash: token.hash,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
      createdAt: now,
    });
    return active;
  });

  if (recipient) {
    const send = deps.sendEmail ?? sendTransactionalEmail;
    const url = resetUrl(token.raw);
    // Deliberately detached: request success does not depend on provider
    // availability, and raw token is never included in logs or audit detail.
    void Promise.resolve()
      .then(() =>
        send({
          to: recipient.email,
          subject: "Reset your Klei Bridal Studio password",
          text: `Hello ${recipient.name},\n\nReset your staff password here: ${url}\n\nThis link expires in 30 minutes and can be used once. If you did not request this, ignore this email.`,
          html: `<p>Hello ${escapeHtml(recipient.name)},</p><p><a href="${escapeHtml(url)}">Reset your staff password</a></p><p>This link expires in 30 minutes and can be used once. If you did not request this, ignore this email.</p>`,
        }),
      )
      .catch(async () => {
        try {
          await deps.db.insert(auditLog).values({
            occurredAt: new Date(),
            actorUserId: null,
            action: "auth.password_reset_mail_failed",
            entityType: "staff_user",
            entityId: recipient.id,
            detail: {},
          });
        } catch {
          // Mail and its failure audit are both best-effort after commit.
        }
      });
  }

  return { accepted: true };
}

export async function confirmPasswordReset(
  input: { token: string; newPassword: string; ip: string | null; userAgent: string | null },
  deps: PasswordResetConfirmationDeps = defaultConfirmationDeps,
): Promise<ConfirmPasswordResetResult> {
  const now = deps.now?.() ?? new Date();
  const tokenHash = hashPasswordResetToken(input.token);
  const [candidate] = await deps.db
    .select({
      staffUserId: passwordResetTokens.staffUserId,
      name: staffUsers.name,
      email: staffUsers.email,
    })
    .from(passwordResetTokens)
    .innerJoin(staffUsers, eq(staffUsers.id, passwordResetTokens.staffUserId))
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        isNull(passwordResetTokens.revokedAt),
        gt(passwordResetTokens.expiresAt, now),
        eq(staffUsers.isActive, true),
      ),
    )
    .limit(1);

  if (!candidate) return { ok: false, reason: "invalid_token" };
  const policy = await assertPasswordAllowed(input.newPassword, { email: candidate.email });
  if (!policy.ok) return { ok: false, reason: policy.reason };
  const passwordHash = await hashPassword(input.newPassword);
  const result = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          eq(passwordResetTokens.staffUserId, candidate.staffUserId),
          isNull(passwordResetTokens.usedAt),
          isNull(passwordResetTokens.revokedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ staffUserId: passwordResetTokens.staffUserId });
    if (!claimed) return { ok: false as const, reason: "invalid_token" as const };

    await tx
      .update(staffUsers)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(and(eq(staffUsers.id, candidate.staffUserId), eq(staffUsers.isActive, true)));
    const revokedSessions = await revokeAllSessionsForUser(tx, candidate.staffUserId, now);
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: null,
      action: "staff.password_reset",
      ip: inetOrNull(input.ip),
      entityType: "staff_user",
      entityId: candidate.staffUserId,
      detail: { revoked_sessions: revokedSessions },
    });
    return { ok: true as const, revokedSessions };
  });

  if (!result.ok) return result;
  try {
    const send = deps.sendEmail ?? sendTransactionalEmail;
    await send({
      to: candidate.email,
      ...passwordChangedEmail({
        name: candidate.name,
        occurredAt: now,
        ip: input.ip,
        userAgent: input.userAgent,
        timezone: env.STUDIO_TIMEZONE,
      }),
    });
  } catch {
    try {
      await deps.db.insert(auditLog).values({
        occurredAt: new Date(),
        actorUserId: null,
        action: "mail.password_changed_failed",
        ip: inetOrNull(input.ip),
        entityType: "staff_user",
        entityId: candidate.staffUserId,
        detail: { operation: "reset" },
      });
    } catch {
      // Password reset remains successful when notification delivery fails.
    }
  }
  return result;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char]!;
  });
}
