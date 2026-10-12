import "server-only";
import { eq, sql } from "drizzle-orm";

import type { Database } from "@/server/db/client";
import { auditLog, enquiries } from "@/server/db/schema";
import { PipelineError } from "@/server/pipeline/errors";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import type { EnquiryEraseReason } from "@/shared/schemas/enquiryAdmin";

/**
 * The one erased marker (spec/api/admin-enquiries): `email` is required on
 * submit, so only erasure leaves it null. Use this everywhere (list, detail,
 * 409s, the helper, /e/<token>); never re-implement it inline.
 * ponytail: breaks if email ever becomes optional on submit; then add an
 * `erased_at timestamptz` column and point this at it.
 */
export const isErased = sql<boolean>`(${enquiries.email} IS NULL)`;

/**
 * Nulled on erase (security-eng). Everything else stays: wedding_date,
 * source, band, notice, channel, status, created_at, reference, token_hash,
 * and every enquiry_gowns snapshot row.
 */
export const ENQUIRY_PII_COLUMNS = [
  "firstName",
  "lastName",
  "contactNumber",
  "email",
  "message",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "referrerHost",
] as const satisfies readonly (keyof typeof enquiries.$inferSelect)[];

const nulled = Object.fromEntries(ENQUIRY_PII_COLUMNS.map((c) => [c, null]));

/**
 * The one erase (decision/enquiry-erasure-helper): manual erase and the
 * KBS-30 retention job both call it inside their own transaction. The
 * erased check runs under the row lock, so two concurrent erases serialise
 * and the second gets 409 before any write (retention treats that 409 as
 * "already erased, skip"). Nulls in place, never deletes; never touches
 * enquiry_gowns or existing audit rows.
 */
export async function anonymiseEnquiry(
  tx: Database,
  id: string,
  opts: {
    actorUserId: string | null;
    trigger: "manual" | "retention";
    reason: EnquiryEraseReason;
    ip?: string | null;
  },
) {
  const [row] = await tx
    .select({ erased: isErased })
    .from(enquiries)
    .where(eq(enquiries.id, id))
    .for("update");
  if (!row) throw new PipelineError(404, "NOT_FOUND", "Enquiry not found.");
  if (row.erased) throw new PipelineError(409, "CONFLICT", "This enquiry is already erased.");

  await tx.update(enquiries).set(nulled).where(eq(enquiries.id, id));
  await tx.insert(auditLog).values({
    occurredAt: new Date(),
    actorUserId: opts.actorUserId,
    action: "enquiry.erase",
    entityType: "enquiry",
    entityId: id,
    // Enum values only: audit_log is append-only and can never be erased.
    detail: { trigger: opts.trigger, reason: opts.reason },
    ip: inetOrNull(opts.ip ?? null),
  });
}
