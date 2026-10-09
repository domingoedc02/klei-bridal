import { createHash, randomBytes } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { env } from "@/config/env";
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
