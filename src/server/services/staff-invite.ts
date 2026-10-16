import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db as defaultDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import { auditLog, passwordResetTokens, staffMailOutbox, staffUsers } from "@/server/db/schema";
import {
  cancelPendingStaffInviteMail,
  enqueueStaffInviteMail,
} from "@/server/mail/staff-invite-outbox";
import { staffInviteEmail } from "@/server/mail/staff-invite";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";

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

export type StaffInviteState = {
  state: "pending" | "expired" | "accepted";
  expires_at: string;
  accepted_at: string | null;
  delivery: "sent" | "failed";
} | null;

async function issueStaffInviteInTransaction(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  staffUserId: string,
  now: Date,
  input?: { email?: string; resend?: boolean },
): Promise<StaffInvite | null> {
  const [staff] = await tx
    .select({
      id: staffUsers.id,
      name: staffUsers.name,
      email: staffUsers.email,
      passwordHash: staffUsers.passwordHash,
      tempPasswordExpiresAt: staffUsers.tempPasswordExpiresAt,
      isActive: staffUsers.isActive,
    })
    .from(staffUsers)
    .where(eq(staffUsers.id, staffUserId))
    .for("update");
  if (!staff) return null;
  if (!staff.isActive) {
    if (input?.resend) {
      throw new PipelineError(409, "ACCOUNT_DISABLED", "This staff account is disabled.");
    }
    return null;
  }
  if (staff.passwordHash && !staff.tempPasswordExpiresAt) {
    throw new PipelineError(409, "INVITE_ACCEPTED", "This staff account already has a password.");
  }
  if (input?.email && input.email !== staff.email) {
    const [taken] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(and(sql`lower(${staffUsers.email}) = ${input.email}`, eq(staffUsers.isActive, true)))
      .limit(1);
    if (taken && taken.id !== staffUserId) {
      throw new PipelineError(409, "CONFLICT", "This email is already in use.");
    }
    await tx
      .update(staffUsers)
      .set({ email: input.email, passwordHash: null, tempPasswordExpiresAt: null, updatedAt: now })
      .where(eq(staffUsers.id, staffUserId));
    await revokeAllSessionsForUser(tx, staffUserId, now);
  }

  const token = newInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_MS);
  const oldTokens = await tx
    .select({ id: passwordResetTokens.id })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.staffUserId, staffUserId),
        isNull(passwordResetTokens.usedAt),
        isNull(passwordResetTokens.revokedAt),
      ),
    );
  await tx
    .update(passwordResetTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(passwordResetTokens.staffUserId, staffUserId),
        isNull(passwordResetTokens.usedAt),
        isNull(passwordResetTokens.revokedAt),
      ),
    );
  await cancelPendingStaffInviteMail(
    tx,
    oldTokens.map((row) => row.id),
  );
  const [tokenRow] = await tx
    .insert(passwordResetTokens)
    .values({ staffUserId, kind: "invite", tokenHash: token.hash, expiresAt, createdAt: now })
    .returning({ id: passwordResetTokens.id });
  if (!tokenRow) throw new Error("invite token insert returned no row");
  await enqueueStaffInviteMail(tx, {
    tokenId: tokenRow.id,
    idempotencyKey: `staff-invite-${token.hash}`,
    email: {
      to: input?.email ?? staff.email,
      ...staffInviteEmail({ name: staff.name, token: token.raw, expiresAt }),
    },
  });
  return {
    staffUserId: staff.id,
    name: staff.name,
    email: input?.email ?? staff.email,
    rawToken: token.raw,
    expiresAt,
  };
}

/** Issue invite, revoking every unused token and cancelling pending delivery atomically. */
export async function issueStaffInvite(
  staffUserId: string,
  deps: { db?: Database; now?: () => Date; email?: string } = {},
): Promise<StaffInvite | null> {
  const db = deps.db ?? defaultDb;
  const now = deps.now?.() ?? new Date();
  return db.transaction((tx) =>
    issueStaffInviteInTransaction(tx, staffUserId, now, { email: deps.email }),
  );
}

export async function createStaffInviteLifecycle(
  input: { name: string; email: string },
  actor: Principal,
  ip: string | null,
  deps: { db?: Database; now?: () => Date } = {},
) {
  const db = deps.db ?? defaultDb;
  const now = deps.now?.() ?? new Date();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(sql`lower(${staffUsers.email}) = ${input.email.trim().toLowerCase()}`)
      .limit(1);
    if (existing) throw new PipelineError(409, "CONFLICT", "This email is already in use.");
    const [created] = await tx
      .insert(staffUsers)
      .values({
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        passwordHash: null,
        tempPasswordExpiresAt: null,
      })
      .returning({
        id: staffUsers.id,
        name: staffUsers.name,
        email: staffUsers.email,
        isActive: staffUsers.isActive,
        tempPasswordExpiresAt: staffUsers.tempPasswordExpiresAt,
        lastSignInAt: staffUsers.lastSignInAt,
        createdAt: staffUsers.createdAt,
      });
    if (!created) throw new Error("staff insert returned no row");
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: actor.staff.id,
      action: "staff.create",
      entityType: "staff_user",
      entityId: created.id,
      detail: {},
      ip: inetOrNull(ip),
    });
    const invite = await issueStaffInviteInTransaction(tx, created.id, now);
    if (!invite) throw new Error("created staff invite missing");
    return { created, invite };
  });
}

export async function resendStaffInvite(
  staffUserId: string,
  actor: Principal,
  ip: string | null,
  deps: { db?: Database; now?: () => Date; email?: string } = {},
) {
  const db = deps.db ?? defaultDb;
  const now = deps.now?.() ?? new Date();
  return db.transaction(async (tx) => {
    const invite = await issueStaffInviteInTransaction(tx, staffUserId, now, {
      email: deps.email,
      resend: true,
    });
    if (!invite) throw new PipelineError(404, "NOT_FOUND", "Staff account not found.");
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: actor.staff.id,
      action: "staff.invite_resend",
      entityType: "staff_user",
      entityId: staffUserId,
      detail: {},
      ip: inetOrNull(ip),
    });
    return invite;
  });
}

export async function getStaffInviteState(
  staffUserId: string,
  db: Database = defaultDb,
  now = new Date(),
): Promise<StaffInviteState> {
  const [token] = await db
    .select({
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
      revokedAt: passwordResetTokens.revokedAt,
      outboxStatus: staffMailOutbox.status,
    })
    .from(passwordResetTokens)
    .leftJoin(staffMailOutbox, eq(staffMailOutbox.tokenId, passwordResetTokens.id))
    .where(
      and(eq(passwordResetTokens.staffUserId, staffUserId), eq(passwordResetTokens.kind, "invite")),
    )
    .orderBy(desc(passwordResetTokens.createdAt))
    .limit(1);
  if (!token) return null;
  const state = token.usedAt
    ? "accepted"
    : token.revokedAt || token.expiresAt <= now || token.outboxStatus === "failed"
      ? "expired"
      : "pending";
  return {
    state,
    expires_at: token.expiresAt.toISOString(),
    accepted_at: token.usedAt?.toISOString() ?? null,
    delivery: token.outboxStatus === "failed" ? "failed" : "sent",
  };
}
