import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, passwordResetTokens, staffMailOutbox } from "@/server/db/schema";
import { sendTransactionalEmail, type TransactionalEmail } from "@/server/mail/send";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const ALGORITHM = "aes-256-gcm";

type MailPayload = TransactionalEmail;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Keyring = Map<number, Buffer>;

function keyring(): Keyring {
  return new Map(
    env.STAFF_MAIL_DATA_KEYS.split(",").map((entry) => {
      const [version, hex] = entry.trim().split(":");
      if (!version || !hex || !/^\d+$/.test(version) || !/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error("STAFF_MAIL_DATA_KEYS must use version:64-hex-key entries");
      }
      return [Number(version), Buffer.from(hex, "hex")];
    }),
  );
}

function currentKeyVersion(): number {
  return env.STAFF_MAIL_DATA_KEY_VERSION;
}

function key(version: number): Buffer {
  const value = keyring().get(version);
  if (!value) throw new Error(`staff mail data key version ${version} unavailable`);
  return value;
}

export function encryptStaffMailPayload(
  payload: MailPayload,
  version = currentKeyVersion(),
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(version), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptStaffMailPayload(payload: Buffer, version: number): MailPayload {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv(ALGORITHM, key(version), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"),
  ) as MailPayload;
}

/** Re-encrypt one outbox row under current key inside one transaction. */
export async function rewrapStaffMailPayload(db: Database, outboxId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: staffMailOutbox.id,
        payload: staffMailOutbox.payload,
        keyVersion: staffMailOutbox.keyVersion,
      })
      .from(staffMailOutbox)
      .where(eq(staffMailOutbox.id, outboxId))
      .for("update");
    if (!row?.payload || row.keyVersion === currentKeyVersion()) return false;

    await tx
      .update(staffMailOutbox)
      .set({
        payload: encryptStaffMailPayload(decryptStaffMailPayload(row.payload, row.keyVersion)),
        keyVersion: currentKeyVersion(),
        updatedAt: new Date(),
      })
      .where(eq(staffMailOutbox.id, row.id));
    return true;
  });
}

export async function enqueueStaffInviteMail(
  tx: Tx,
  input: { tokenId: string; idempotencyKey: string; email: MailPayload },
): Promise<void> {
  await tx.insert(staffMailOutbox).values({
    tokenId: input.tokenId,
    idempotencyKey: input.idempotencyKey,
    payload: encryptStaffMailPayload(input.email),
    keyVersion: currentKeyVersion(),
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
      .set({
        status: "failed",
        payload: null,
        leaseId: null,
        leaseUntil: null,
        lastErrorCode: errorCode,
        updatedAt: now,
      })
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

/** Claim and deliver pending invite mail. Lease plus provider idempotency prevents duplicate sends. */
export async function processStaffInviteMail(
  deps: { db?: Database; send?: typeof sendTransactionalEmail; now?: () => Date } = {},
): Promise<boolean> {
  const db = deps.db ?? defaultDb;
  const send = deps.send ?? sendTransactionalEmail;
  const now = deps.now?.() ?? new Date();
  const leaseId = randomUUID();
  const [row] = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: staffMailOutbox.id,
        payload: staffMailOutbox.payload,
        attempts: staffMailOutbox.attempts,
        keyVersion: staffMailOutbox.keyVersion,
        idempotencyKey: staffMailOutbox.idempotencyKey,
      })
      .from(staffMailOutbox)
      .where(
        and(
          lte(staffMailOutbox.availableAt, now),
          or(
            eq(staffMailOutbox.status, "pending"),
            and(eq(staffMailOutbox.status, "in_flight"), lte(staffMailOutbox.leaseUntil, now)),
          ),
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate?.payload) return [];
    await tx
      .update(staffMailOutbox)
      .set({
        status: "in_flight",
        leaseId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${staffMailOutbox.attempts} + 1`,
        updatedAt: now,
      })
      .where(eq(staffMailOutbox.id, candidate.id));
    return [
      {
        ...candidate,
        attempts: candidate.attempts + 1,
      },
    ];
  });
  if (!row?.payload) return false;

  try {
    const result = await send(decryptStaffMailPayload(row.payload, row.keyVersion), {
      idempotencyKey: row.idempotencyKey,
    });
    const providerMessageId =
      result && typeof result === "object" ? (result.providerMessageId ?? null) : null;
    await db
      .update(staffMailOutbox)
      .set({
        status: "sent",
        payload: null,
        leaseId: null,
        leaseUntil: null,
        providerMessageId,
        updatedAt: now,
      })
      .where(and(eq(staffMailOutbox.id, row.id), eq(staffMailOutbox.leaseId, leaseId)));
  } catch {
    if (row.attempts >= MAX_ATTEMPTS) {
      await terminalFailure(row.id, "provider_rejected", now, db);
    } else {
      await db
        .update(staffMailOutbox)
        .set({
          status: "pending",
          leaseId: null,
          leaseUntil: null,
          availableAt: new Date(now.getTime() + RETRY_DELAY_MS),
          lastErrorCode: "provider_rejected",
          updatedAt: now,
        })
        .where(and(eq(staffMailOutbox.id, row.id), eq(staffMailOutbox.leaseId, leaseId)));
    }
  }
  return true;
}
