import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq, lte, or, sql } from "drizzle-orm";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import { mailOutbox } from "@/server/db/schema";
import { sendTransactionalEmail, type TransactionalEmail } from "@/server/mail/send";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const ALGORITHM = "aes-256-gcm";

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
  if (!value) throw new Error(`mail data key version ${version} unavailable`);
  return value;
}

function encryptPayload(payload: TransactionalEmail, version = currentKeyVersion()): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(version), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptPayload(payload: Buffer, version: number): TransactionalEmail {
  const decipher = createDecipheriv(ALGORITHM, key(version), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8"),
  ) as TransactionalEmail;
}

export async function enqueueMail(
  tx: Tx,
  input: { idempotencyKey: string; email: TransactionalEmail; availableAt?: Date },
): Promise<void> {
  await tx.insert(mailOutbox).values({
    idempotencyKey: input.idempotencyKey,
    payload: encryptPayload(input.email),
    keyVersion: currentKeyVersion(),
    ...(input.availableAt ? { availableAt: input.availableAt } : {}),
  });
}

async function markFailed(id: string, leaseId: string, now: Date, db: Database, terminal: boolean) {
  await db
    .update(mailOutbox)
    .set(
      terminal
        ? {
            status: "failed",
            payload: null,
            leaseId: null,
            leaseUntil: null,
            lastErrorCode: "provider_rejected",
            updatedAt: now,
          }
        : {
            status: "pending",
            leaseId: null,
            leaseUntil: null,
            availableAt: new Date(now.getTime() + RETRY_DELAY_MS),
            lastErrorCode: "provider_rejected",
            updatedAt: now,
          },
    )
    .where(and(eq(mailOutbox.id, id), eq(mailOutbox.leaseId, leaseId)));
}

export async function processMailOutbox(
  deps: {
    db?: Database;
    send?: (
      message: TransactionalEmail,
      options?: { idempotencyKey?: string },
    ) => Promise<{ providerMessageId?: string } | void>;
    now?: () => Date;
    outboxId?: string;
  } = {},
): Promise<boolean> {
  const db = deps.db ?? defaultDb;
  const send = deps.send ?? sendTransactionalEmail;
  const now = deps.now?.() ?? new Date();
  const leaseId = randomUUID();
  const [row] = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: mailOutbox.id,
        payload: mailOutbox.payload,
        attempts: mailOutbox.attempts,
        keyVersion: mailOutbox.keyVersion,
        idempotencyKey: mailOutbox.idempotencyKey,
      })
      .from(mailOutbox)
      .where(
        and(
          deps.outboxId ? eq(mailOutbox.id, deps.outboxId) : undefined,
          lte(mailOutbox.availableAt, now),
          or(
            eq(mailOutbox.status, "pending"),
            and(eq(mailOutbox.status, "in_flight"), lte(mailOutbox.leaseUntil, now)),
          ),
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate?.payload) return [];
    await tx
      .update(mailOutbox)
      .set({
        status: "in_flight",
        leaseId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        attempts: sql`${mailOutbox.attempts} + 1`,
        updatedAt: now,
      })
      .where(eq(mailOutbox.id, candidate.id));
    return [{ ...candidate, attempts: candidate.attempts + 1 }];
  });
  if (!row?.payload) return false;

  try {
    const result = await send(decryptPayload(row.payload, row.keyVersion), {
      idempotencyKey: row.idempotencyKey,
    });
    await db
      .update(mailOutbox)
      .set({
        status: "sent",
        payload: null,
        leaseId: null,
        leaseUntil: null,
        providerMessageId: result && typeof result === "object" ? result.providerMessageId ?? null : null,
        updatedAt: now,
      })
      .where(and(eq(mailOutbox.id, row.id), eq(mailOutbox.leaseId, leaseId)));
  } catch {
    await markFailed(row.id, leaseId, now, db, row.attempts >= MAX_ATTEMPTS);
  }
  return true;
}
