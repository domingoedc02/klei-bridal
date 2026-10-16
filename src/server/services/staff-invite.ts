import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { db as defaultDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import { passwordResetTokens, staffUsers } from "@/server/db/schema";
import { staffInviteEmail } from "@/server/mail/staff-invite";
import {
  cancelPendingStaffInviteMail,
  enqueueStaffInviteMail,
} from "@/server/mail/staff-invite-outbox";

const INVITE_TOKEN_BYTES = 32;
export const INVITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashStaffInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashStaffInviteToken(raw) };
}

export type StaffInvite = {
  staffUserId: string;
  name: string;
  email: string;
  rawToken: string;
  expiresAt: Date;
};

/**
 * Revoke unused tokens, then persist one 24-hour invite token atomically.
 * Caller hands rawToken to the mail layer; this service never logs or stores it.
 */
export async function issueStaffInvite(
  staffUserId: string,
  deps: { db?: Database; now?: () => Date } = {},
): Promise<StaffInvite | null> {
  const db = deps.db ?? defaultDb;
  const now = deps.now?.() ?? new Date();
  const token = newInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_MS);

  return db.transaction(async (tx) => {
    const [staff] = await tx
      .select({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email })
      .from(staffUsers)
      .where(and(eq(staffUsers.id, staffUserId), eq(staffUsers.isActive, true)))
      .limit(1)
      .for("update");
    if (!staff) return null;

    const activeTokens = await tx
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.staffUserId, staffUserId),
          eq(passwordResetTokens.kind, "invite"),
          isNull(passwordResetTokens.usedAt),
          isNull(passwordResetTokens.revokedAt),
        ),
      )
      .for("update");
    await cancelPendingStaffInviteMail(
      tx,
      activeTokens.map(({ id }) => id),
    );
    await tx
      .update(passwordResetTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passwordResetTokens.staffUserId, staffUserId),
          eq(passwordResetTokens.kind, "invite"),
          isNull(passwordResetTokens.usedAt),
          isNull(passwordResetTokens.revokedAt),
        ),
      );
    const [createdToken] = await tx
      .insert(passwordResetTokens)
      .values({
        staffUserId,
        kind: "invite",
        tokenHash: token.hash,
        expiresAt,
        createdAt: now,
      })
      .returning({ id: passwordResetTokens.id });
    if (!createdToken) throw new Error("invite token insert returned no row");
    await enqueueStaffInviteMail(tx, {
      tokenId: createdToken.id,
      idempotencyKey: `staff-invite:${token.hash}`,
      email: {
        to: staff.email,
        ...staffInviteEmail({ name: staff.name, token: token.raw, expiresAt }),
      },
    });

    return {
      staffUserId: staff.id,
      name: staff.name,
      email: staff.email,
      rawToken: token.raw,
      expiresAt,
    };
  });
}
