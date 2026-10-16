import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, passwordResetTokens, staffMailOutbox } from "@/server/db/schema";
import { sendTransactionalEmail, type TransactionalEmail } from "@/server/mail/send";

const KEY_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;
const ALGORITHM = "aes-256-gcm";

type MailPayload = TransactionalEmail;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function key(): Buffer {
  return createHash("sha256").update(env.SESSION_SECRET).digest();
}

export function encryptStaffMailPayload(payload: MailPayload): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptStaffMailPayload(payload: Buffer): MailPayload {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"),
  ) as MailPayload;
}

export async function enqueueStaffInviteMail(
  tx: Tx,
  input: { tokenId: string; idempotencyKey: string; email: MailPayload },
): Promise<void> {
  await tx.insert(staffMailOutbox).values({
    tokenId: input.tokenId,
    idempotencyKey: input.idempotencyKey,
    payload: encryptStaffMailPayload(input.email),
    keyVersion: KEY_VERSION,
  });
}

export async function cancelPendingStaffInviteMail(tx: Tx, tokenIds: string[]): Promise<void> {
  if (!tokenIds.length) return;
  await tx
    .update(staffMailOutbox)
    .set({ status: "cancelled", payload: null, updatedAt: new Date() })
    .where(and(inArray(staffMailOutbox.tokenId, tokenIds), eq(staffMailOutbox.status, "pending")));
}

async function terminalFailure(
  id: string,
  errorCode: string,
  now: Date,
  db: Database,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ tokenId: staffMailOutbox.tokenId, staffUserId: passwordResetTokens.staffUserId })
      .from(staffMailOutbox)
      .innerJoin(passwordResetTokens, eq(passwordResetTokens.id, staffMailOutbox.tokenId))
      .where(eq(staffMailOutbox.id, id))
      .for("update");
    if (!row) return;
    await tx
      .update(passwordResetTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(passwordResetTokens.id, row.tokenId),
          isNull(passwordResetTokens.usedAt),
          isNull(passwordResetTokens.revokedAt),
        ),
      );
    await tx
      .update(staffMailOutbox)
      .set({ status: "failed", payload: null, lastErrorCode: errorCode, updatedAt: now })
      .where(eq(staffMailOutbox.id, id));
    await tx.insert(auditLog).values({
      occurredAt: now,
      actorUserId: null,
      action: "staff.invite_mail_failed",
      entityType: "staff_user",
      entityId: row.staffUserId,
      detail: { delivery: "failed", error_code: errorCode },
    });
  });
}

/** Claim and deliver pending invite mail. Safe for multiple workers through row locks. */
export async function processStaffInviteMail(
  deps: { db?: Database; send?: typeof sendTransactionalEmail; now?: () => Date } = {},
): Promise<boolean> {
  const db = deps.db ?? defaultDb;
  const send = deps.send ?? sendTransactionalEmail;
  const now = deps.now?.() ?? new Date();
  const [row] = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: staffMailOutbox.id,
        payload: staffMailOutbox.payload,
        attempts: staffMailOutbox.attempts,
      })
      .from(staffMailOutbox)
      .where(and(eq(staffMailOutbox.status, "pending"), lte(staffMailOutbox.availableAt, now)))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate?.payload) return [];
    await tx
      .update(staffMailOutbox)
      .set({ attempts: sql`${staffMailOutbox.attempts} + 1`, updatedAt: now })
      .where(eq(staffMailOutbox.id, candidate.id));
    return [candidate];
  });
  if (!row?.payload) return false;

  try {
    const result = await send(decryptStaffMailPayload(row.payload));
    const providerMessageId =
      result && typeof result === "object" ? (result.providerMessageId ?? null) : null;
    await db
      .update(staffMailOutbox)
      .set({
        status: "sent",
        payload: null,
        providerMessageId,
        updatedAt: now,
      })
      .where(eq(staffMailOutbox.id, row.id));
  } catch {
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      await terminalFailure(row.id, "provider_rejected", now, db);
    } else {
      await db
        .update(staffMailOutbox)
        .set({
          availableAt: new Date(now.getTime() + RETRY_DELAY_MS),
          lastErrorCode: "provider_rejected",
          updatedAt: now,
        })
        .where(eq(staffMailOutbox.id, row.id));
    }
  }
  return true;
}
