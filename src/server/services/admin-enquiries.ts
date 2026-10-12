import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, enquiries, enquiryGowns, staffUsers } from "@/server/db/schema";
import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import type { LeadTimeBand } from "@/shared/leadtime";
import type { EnquiryEraseReason, EnquiryStatus } from "@/shared/schemas/enquiryAdmin";

import { anonymiseEnquiry, isErased } from "./enquiry-erasure";

export { ENQUIRY_STATUSES } from "@/shared/schemas/enquiryAdmin";

export interface EnquiryListQuery {
  page: number;
  per_page: number;
  search?: string;
  status: EnquiryStatus[];
  band: LeadTimeBand[];
}

/**
 * Who marked it handled (status 'read') and when, from the latest
 * enquiry.status_change → 'read' audit row, only while it is still 'read'
 * (spec/api/admin-enquiries). One lateral join per page, served by
 * audit_log_entity_idx, never a query per row.
 */
function withHandled(db: Database) {
  const handled = db
    .select({ actorId: auditLog.actorUserId, at: auditLog.occurredAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "enquiry"),
        eq(auditLog.entityId, enquiries.id),
        eq(auditLog.action, "enquiry.status_change"),
        sql`${auditLog.detail}->>'to' = 'read'`,
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(1)
    .as("handled");
  return { handled, on: eq(enquiries.status, "read") };
}

const handledBy = (id: string | null, name: string | null, at: Date | null) => ({
  handled_by: id && name ? { id, name } : null,
  handled_at: at ? at.toISOString() : null,
});

/** `%`, `_` and `\` in a staff search are literal, not wildcards. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * GET /admin/enquiries (KBS-23-1): most urgent wedding first, then oldest
 * submission. Rows carry no message, email or phone; opening one is the
 * audited act. A reference matches exactly, so a search for a reference
 * never issued looks the same as one that matches nothing else.
 */
export async function listEnquiries(input: EnquiryListQuery, db: Database = defaultDb) {
  const conditions: SQL[] = [];
  if (input.status.length) conditions.push(inArray(enquiries.status, input.status));
  if (input.band.length) conditions.push(inArray(enquiries.leadTimeBandShown, input.band));
  if (input.search) {
    const like = `%${likeEscape(input.search)}%`;
    conditions.push(
      or(
        ilike(sql`concat_ws(' ', ${enquiries.firstName}, ${enquiries.lastName})`, like),
        ilike(enquiries.email, like),
        eq(enquiries.reference, input.search.toUpperCase()),
      )!,
    );
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const { handled, on } = withHandled(db);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: enquiries.id,
        reference: enquiries.reference,
        first_name: enquiries.firstName,
        last_name: enquiries.lastName,
        wedding_date: enquiries.weddingDate,
        gown_count: sql<number>`(SELECT count(*)::int FROM ${enquiryGowns} WHERE ${enquiryGowns.enquiryId} = ${enquiries.id})`,
        lead_time_band: enquiries.leadTimeBandShown,
        chat_channel: enquiries.chatChannelChosen,
        status: enquiries.status,
        is_erased: isErased,
        created_at: enquiries.createdAt,
        handledId: staffUsers.id,
        handledName: staffUsers.name,
        handledAt: handled.at,
      })
      .from(enquiries)
      .leftJoinLateral(handled, on)
      .leftJoin(staffUsers, eq(staffUsers.id, handled.actorId))
      .where(where)
      .orderBy(asc(enquiries.weddingDate), asc(enquiries.createdAt), asc(enquiries.id))
      .limit(input.per_page)
      .offset((input.page - 1) * input.per_page),
    db.select({ n: count() }).from(enquiries).where(where),
  ]);

  const totalItems = total?.n ?? 0;
  return {
    items: rows.map(({ handledId, handledName, handledAt, created_at, ...row }) => ({
      ...row,
      created_at: created_at.toISOString(),
      ...handledBy(handledId, handledName, handledAt),
    })),
    page: input.page,
    per_page: input.per_page,
    total_items: totalItems,
    total_pages: Math.ceil(totalItems / input.per_page),
  };
}

/** The detail shape every inbox read and write returns. Writes no audit row itself. */
async function readDetail(db: Database, id: string) {
  const { handled, on } = withHandled(db);
  const [row] = await db
    .select({
      enquiry: enquiries,
      is_erased: isErased,
      handledId: staffUsers.id,
      handledName: staffUsers.name,
      handledAt: handled.at,
    })
    .from(enquiries)
    .leftJoinLateral(handled, on)
    .leftJoin(staffUsers, eq(staffUsers.id, handled.actorId))
    .where(eq(enquiries.id, id));
  if (!row) throw new PipelineError(404, "NOT_FOUND", "Enquiry not found.");

  const gowns = await db
    .select({
      gown_id: enquiryGowns.gownId,
      name: enquiryGowns.gownNameSnapshot,
      price_minor: enquiryGowns.priceMinorSnapshot,
      price_status: enquiryGowns.priceStatusSnapshot,
      currency: enquiryGowns.currencySnapshot,
    })
    .from(enquiryGowns)
    .where(eq(enquiryGowns.enquiryId, id))
    .orderBy(asc(enquiryGowns.gownNameSnapshot));

  const e = row.enquiry;
  return {
    id: e.id,
    reference: e.reference,
    first_name: e.firstName,
    last_name: e.lastName,
    contact_number: e.contactNumber,
    email: e.email,
    wedding_date: e.weddingDate,
    message: e.message,
    source: e.source,
    utm_source: e.utmSource,
    utm_medium: e.utmMedium,
    utm_campaign: e.utmCampaign,
    referrer_host: e.referrerHost,
    chat_channel: e.chatChannelChosen,
    lead_time_band: e.leadTimeBandShown,
    lead_time_notice: e.leadTimeNoticeShown,
    status: e.status,
    // A bounced studio email is visible here, not silent (KBS-23 failure branches).
    studio_email_status: e.studioEmailStatus,
    bride_email_status: e.brideEmailStatus,
    created_at: e.createdAt.toISOString(),
    is_erased: row.is_erased,
    gowns,
    ...handledBy(row.handledId, row.handledName, row.handledAt),
  };
}

/**
 * GET /admin/enquiries/:id (KBS-23-1): every field plus the gowns as she saw
 * them. The enquiry.view audit row is written in the same transaction as the
 * read: if it cannot be written, the detail is not returned (KBS-23 NFRs).
 * Opening never changes status.
 */
export async function getEnquiryDetail(
  id: string,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const detail = await readDetail(tx as unknown as Database, id);
    await tx.insert(auditLog).values({
      occurredAt: new Date(),
      actorUserId: actor.staff.id,
      action: "enquiry.view",
      entityType: "enquiry",
      entityId: id,
      ip: inetOrNull(ip),
    });
    return detail;
  });
}

/**
 * PATCH /admin/enquiries/:id (KBS-23-2): 'read' marks handled, 'new' undoes a
 * mis-tap. The audit row is in the same transaction and not best-effort.
 * Same status is a no-op with no audit row; an erased enquiry is frozen (409).
 */
export async function setEnquiryStatus(
  id: string,
  status: EnquiryStatus,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: enquiries.status, erased: isErased })
      .from(enquiries)
      .where(eq(enquiries.id, id))
      .for("update");
    if (!row) throw new PipelineError(404, "NOT_FOUND", "Enquiry not found.");
    if (row.erased) throw new PipelineError(409, "CONFLICT", "This enquiry is erased.");
    if (row.status !== status) {
      await tx.update(enquiries).set({ status }).where(eq(enquiries.id, id));
      await tx.insert(auditLog).values({
        occurredAt: new Date(),
        actorUserId: actor.staff.id,
        action: "enquiry.status_change",
        entityType: "enquiry",
        entityId: id,
        detail: { from: row.status, to: status },
        ip: inetOrNull(ip),
      });
    }
    return readDetail(tx as unknown as Database, id);
  });
}

/** POST /admin/enquiries/:id/erase (KBS-23-2): staff-triggered erase; 409 on a repeat with no audit row. */
export async function eraseEnquiry(
  id: string,
  reason: EnquiryEraseReason,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    await anonymiseEnquiry(t, id, { actorUserId: actor.staff.id, trigger: "manual", reason, ip });
    return readDetail(t, id);
  });
}
