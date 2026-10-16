import { createHash, randomBytes, randomInt } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import {
  dispatchEnquiryEmails,
  type EnquiryEmailData,
  type EnquiryMailDeps,
} from "@/server/mail/enquiry";
import { enquiries, enquiryGowns, gowns, settings } from "@/server/db/schema";
import { logger } from "@/server/observability/logger";
import { captureError } from "@/server/observability/sentry";
import { PipelineError } from "@/server/pipeline/errors";
import { daysBetween, isIsoDate, isValidTimeZone, todayIn } from "@/shared/dates";
import {
  DEFAULT_LEAD_TIME_RULE,
  DEFAULT_NOTICE_COPY,
  leadTimeBand,
  type LeadTimeBand,
  type LeadTimeRule,
  type LeadTimeSettings,
} from "@/shared/leadtime";

/**
 * POST /enquiries (KBS-17-1) — the one public write that stores personal data.
 * Field rules from KBS-17 Security / spec/security Input validation.
 * Unknown keys (a forged `source`, `utm_*`) are stripped by z.object (AC-ENQ-21).
 */
const noHtml = (v: string) => !/[<>]/.test(v);
// No control characters: CR/LF in a name would reach mail headers, and NUL makes
// Postgres raise 22021 (an unmapped 500). Messages keep newlines and tabs.
const noControl = (v: string) => !/\p{Cc}/u.test(v);
const noControlButLines = (v: string) => !/[^\P{Cc}\n\r\t]/u.test(v);
const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(noHtml, "Must not contain < or >.")
  .refine(noControl, "Must not contain control characters.");

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
  email: z
    .string()
    .trim()
    .max(254)
    .email()
    .refine(noControl, "Email must not contain control characters."),
  wedding_date: z.string().refine(isIsoDate, "Use a date in YYYY-MM-DD form."),
  message: z
    .string()
    .max(2000)
    .refine(noControlButLines, "Must not contain control characters.")
    .nullish(),
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

/** Pure: raw settings values to a usable config, falling back per AC-ENQ-15. */
export function parseLeadTimeSettings(v: Record<string, unknown>): LeadTimeSettings {
  const weeks = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : null);
  const comfortable = weeks(v.lead_time_comfortable_weeks);
  const floor = weeks(v.lead_time_rush_floor_weeks);
  // A broken pair (missing, or floor above comfortable) falls back whole, never half.
  const rule: LeadTimeRule =
    comfortable !== null && floor !== null && floor <= comfortable
      ? { comfortableWeeks: comfortable, rushFloorWeeks: floor }
      : DEFAULT_LEAD_TIME_RULE;
  const tz = v.studio_timezone;
  const raw = (v.lead_time_notice_copy ?? {}) as Record<string, unknown>;
  const text = (band: "rush" | "in_stock_only") =>
    typeof raw[band] === "string" && (raw[band] as string).trim()
      ? (raw[band] as string)
      : DEFAULT_NOTICE_COPY[band];
  return {
    rule,
    timeZone: typeof tz === "string" && isValidTimeZone(tz) ? tz : "Asia/Manila",
    copy: { comfortable: "", rush: text("rush"), in_stock_only: text("in_stock_only") },
  };
}

/** Lead-time settings for the enquiry page payload and the POST (same source, AC-ENQ-13). */
export async function getLeadTimeSettings(
  tx: Pick<Database, "select"> = defaultDb,
): Promise<LeadTimeSettings> {
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
  return parseLeadTimeSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export interface ChatSettings {
  messengerPage: string | null;
  whatsappNumber: string | null;
  viberNumber: string | null;
}

/** Public hand-off settings. Empty values mean channel is not configured. */
export async function getChatSettings(
  tx: Pick<Database, "select"> = defaultDb,
): Promise<ChatSettings> {
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      inArray(settings.key, [
        "studio_facebook_page",
        "studio_whatsapp_number",
        "studio_viber_number",
      ]),
    );
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    messengerPage: text(values.studio_facebook_page),
    whatsappNumber: text(values.studio_whatsapp_number),
    viberNumber: text(values.studio_viber_number),
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
  deps: { db?: Database; now?: () => Date; mail?: EnquiryMailDeps } = {},
): Promise<EnquiryResult> {
  const db = deps.db ?? defaultDb;
  const email = input.email;
  const gownIds = [...input.gown_ids].sort();
  const dedupeKey = `${email.toLowerCase()}|${gownIds.join(",")}`;

  const transactionResult = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 0))`);

    const lead = await getLeadTimeSettings(tx);
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
        result: {
          created: false,
          reference: existing.reference,
          short_link_url: null,
          lead_time_band: existing.band as LeadTimeBand,
          notice_shown: existing.notice || null,
        },
        mail: null,
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
    const notice = lead.copy[band];
    const message = input.message?.trim() ? input.message : null;

    // A reference collision (30^8 space) is retried, never surfaced as a 409.
    let inserted: { id: string; reference: string } | undefined;
    let token = "";
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      token = randomBytes(32).toString("base64url");
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
        // Only a reference clash is retried; a token_hash clash must surface.
        .onConflictDoNothing({ target: enquiries.reference })
        .returning({ id: enquiries.id, reference: enquiries.reference });
    }
    if (!inserted) throw new Error("enquiry reference space exhausted after 3 attempts");
    const enquiryId = inserted.id;

    if (rows.length > 0) {
      await tx.insert(enquiryGowns).values(
        rows.map((g) => ({
          enquiryId,
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
      result: {
        created: true,
        reference: inserted.reference,
        short_link_url: `${env.SITE_URL}/e/${token}`,
        lead_time_band: band,
        notice_shown: notice || null,
      },
      mail: {
        enquiryId,
        reference: inserted.reference,
        shortLinkUrl: `${env.SITE_URL}/e/${token}`,
        firstName: input.first_name,
        lastName: input.last_name,
        contactNumber: input.contact_number,
        email,
        weddingDate: input.wedding_date,
        message,
        leadTimeBand: band,
        notice,
        gowns: rows.map((gown) => ({
          name: gown.name,
          priceMinor: gown.priceStatus === "priced" ? gown.priceMinor : null,
          priceStatus: gown.priceStatus,
          currency: gown.currency,
        })),
      } satisfies EnquiryEmailData,
    };
  });

  // The transaction is complete before either provider call starts. Mail is
  // deliberately detached from the response path: an outage cannot fail a
  // stored enquiry or turn a successful submission into a 500.
  if (transactionResult.result.created && transactionResult.mail) {
    void dispatchEnquiryEmails(transactionResult.mail, {
      ...deps.mail,
      db,
    }).catch((error: unknown) => {
      logger.error(
        { enquiry_id: transactionResult.mail?.enquiryId, err: error },
        "mail: enquiry dispatch failed",
      );
      captureError(error);
    });
  }
  return transactionResult.result;
}
