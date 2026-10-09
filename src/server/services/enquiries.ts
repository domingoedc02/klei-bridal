import { createHash, randomBytes, randomInt } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import { enquiries, enquiryGowns, gowns, settings } from "@/server/db/schema";
import { PipelineError } from "@/server/pipeline/errors";
import { daysBetween, isIsoDate, isValidTimeZone, todayIn } from "@/shared/dates";
import {
  DEFAULT_LEAD_TIME_RULE,
  DEFAULT_NOTICE_COPY,
  leadTimeBand,
  type LeadTimeBand,
  type LeadTimeRule,
} from "@/shared/leadtime";

/**
 * POST /enquiries (KBS-17-1) — the one public write that stores personal data.
 * Field rules from KBS-17 Security / spec/security Input validation.
 * Unknown keys (a forged `source`, `utm_*`) are stripped by z.object (AC-ENQ-21).
 */
const noHtml = (v: string) => !/[<>]/.test(v);
const name = z.string().trim().min(1).max(100).refine(noHtml, "Must not contain < or >.");

export const enquiryBodySchema = z.object({
  first_name: name,
  last_name: name,
  // International formats, stored exactly as typed (AC-ENQ-27): digits plus
  // + ( ) - . and spaces, 7–15 digits (E.164 max), no PH-format assumption.
  contact_number: z
    .string()
    .trim()
    .max(40)
    .regex(/^\+?[0-9 ().-]+$/, "Enter a phone number, e.g. +63 917 123 4567.")
    .refine((v) => {
      const digits = v.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15;
    }, "Enter a phone number, e.g. +63 917 123 4567."),
  email: z.string().trim().max(254).email(),
  wedding_date: z.string().refine(isIsoDate, "Use a date in YYYY-MM-DD form."),
  message: z.string().max(2000).nullish(),
  // Zero gowns is a valid enquiry (AC-ENQ-04); 50 is the documented cap (AC-ENQ-19).
  gown_ids: z
    .array(z.string().uuid())
    .max(50)
    .default([])
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
});

export type EnquiryInput = z.infer<typeof enquiryBodySchema>;

export interface EnquiryResult {
  created: boolean;
  reference: string;
  /** null on a duplicate: only the token's hash is stored, so the original link cannot be rebuilt. */
  short_link_url: string | null;
  lead_time_band: LeadTimeBand;
  notice_shown: string | null;
}

/** Crockford base32 minus 0 and 1 (it already omits I L O U) — decision/enquiry-link §2. */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const DUPLICATE_WINDOW = "5 minutes";
/** Furthest date accepted; >4 years gets a client-side confirmation only (AC-ENQ-08). */
const MAX_YEARS_AHEAD = 10;

export function newReference(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `KB-${s.slice(0, 4)}-${s.slice(4)}`;
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fieldError(field: string, message: string): PipelineError {
  return new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
    fields: { [field]: message },
  });
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function readLeadTimeSettings(tx: Tx) {
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      inArray(settings.key, [
        "lead_time_comfortable_weeks",
        "lead_time_rush_floor_weeks",
        "lead_time_notice_copy",
        "studio_timezone",
      ]),
    );
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
  const weeks = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : null);
  const comfortable = weeks(v.lead_time_comfortable_weeks);
  const floor = weeks(v.lead_time_rush_floor_weeks);
  // A broken pair (missing, or floor above comfortable) falls back whole, never half.
  const rule: LeadTimeRule =
    comfortable !== null && floor !== null && floor <= comfortable
      ? { comfortableWeeks: comfortable, rushFloorWeeks: floor }
      : DEFAULT_LEAD_TIME_RULE;
  const tz = v.studio_timezone;
  const copy = (v.lead_time_notice_copy ?? {}) as Record<string, unknown>;
  return {
    rule,
    timeZone: typeof tz === "string" && isValidTimeZone(tz) ? tz : "Asia/Manila",
    notice(band: LeadTimeBand): string {
      if (band === "comfortable") return ""; // no notice at 13+ weeks (ADR §2.1)
      const text = copy[band];
      return typeof text === "string" && text.trim() ? text : DEFAULT_NOTICE_COPY[band];
    },
  };
}

/**
 * One transaction: dedupe, re-validate gowns, compute the band, insert the
 * enquiry and its immutable gown snapshot. A duplicate (same email, same gown
 * set, within 5 minutes) returns the existing reference instead of a second
 * row (AC-ENQ-23..26), including under concurrent POSTs (AC-ENQ-24): an
 * advisory lock on the key serialises the check-then-insert.
 */
export async function submitEnquiry(
  input: EnquiryInput,
  deps: { db?: Database; now?: () => Date } = {},
): Promise<EnquiryResult> {
  const db = deps.db ?? defaultDb;
  const email = input.email;
  const gownIds = [...input.gown_ids].sort();
  const dedupeKey = `${email.toLowerCase()}|${gownIds.join(",")}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 0))`);

    const lead = await readLeadTimeSettings(tx);
    const today = todayIn(lead.timeZone, deps.now?.() ?? new Date());
    const days = daysBetween(today, input.wedding_date);
    if (days < 0) throw fieldError("wedding_date", "Choose a date that hasn't passed.");
    if (days > MAX_YEARS_AHEAD * 366) throw fieldError("wedding_date", "Check the year.");

    const [existing] = await tx
      .select({
        reference: enquiries.reference,
        band: enquiries.leadTimeBandShown,
        notice: enquiries.leadTimeNoticeShown,
      })
      .from(enquiries)
      .where(
        and(
          sql`lower(${enquiries.email}) = ${email.toLowerCase()}`,
          sql`${enquiries.createdAt} > now() - ${DUPLICATE_WINDOW}::interval`,
          sql`(SELECT coalesce(array_agg(eg.gown_id ORDER BY eg.gown_id), '{}')
                 FROM ${enquiryGowns} eg WHERE eg.enquiry_id = ${enquiries.id})
              = ${`{${gownIds.join(",")}}`}::uuid[]`,
        ),
      )
      .orderBy(sql`${enquiries.createdAt} DESC`)
      .limit(1);
    if (existing) {
      return {
        created: false,
        reference: existing.reference,
        short_link_url: null,
        lead_time_band: existing.band as LeadTimeBand,
        notice_shown: existing.notice || null,
      };
    }

    // Re-resolve every client-supplied id (AC-ENQ-16/17); FOR SHARE so a gown
    // cannot be unpublished or repriced between this read and the snapshot.
    const rows =
      gownIds.length === 0
        ? []
        : await tx
            .select({
              id: gowns.id,
              name: gowns.name,
              priceMinor: gowns.priceMinor,
              priceStatus: gowns.priceStatus,
              currency: gowns.currency,
            })
            .from(gowns)
            .where(and(inArray(gowns.id, gownIds), eq(gowns.status, "published")))
            .for("share");
    if (rows.length !== gownIds.length) {
      throw fieldError("gown_ids", "One or more gowns are no longer available.");
    }

    const band = leadTimeBand(input.wedding_date, today, lead.rule);
    const notice = lead.notice(band);
    const token = randomBytes(32).toString("base64url");
    const message = input.message?.trim() ? input.message : null;

    // A reference collision (30^8 space) is retried, never surfaced as a 409.
    let inserted: { id: string; reference: string } | undefined;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      [inserted] = await tx
        .insert(enquiries)
        .values({
          reference: newReference(),
          tokenHash: hashLinkToken(token),
          firstName: input.first_name,
          lastName: input.last_name,
          contactNumber: input.contact_number,
          email,
          weddingDate: input.wedding_date,
          message,
          // ponytail: no first-party attribution cookie exists yet
          // (decision/analytics-attribution §2.1); stamp 'direct' server-side
          // and never read a client value. Read the cookie here once it lands.
          source: "direct",
          leadTimeBandShown: band,
          leadTimeNoticeShown: notice,
        })
        .onConflictDoNothing()
        .returning({ id: enquiries.id, reference: enquiries.reference });
    }
    if (!inserted) throw new Error("enquiry reference space exhausted after 3 attempts");

    if (rows.length > 0) {
      await tx.insert(enquiryGowns).values(
        rows.map((g) => ({
          enquiryId: inserted.id,
          gownId: g.id,
          gownNameSnapshot: g.name,
          // Only a price she could see is a price she saw (decision/pricing-display).
          priceMinorSnapshot: g.priceStatus === "priced" ? g.priceMinor : null,
          priceStatusSnapshot: g.priceStatus,
          currencySnapshot: g.currency,
        })),
      );
    }

    return {
      created: true,
      reference: inserted.reference,
      short_link_url: `${env.SITE_URL}/e/${token}`,
      lead_time_band: band,
      notice_shown: notice || null,
    };
  });
}
