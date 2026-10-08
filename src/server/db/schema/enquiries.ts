import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { generateId } from "../uuid";

/**
 * The personal-data table. Immutable once created — the only mutable
 * column is `status`, plus the GDPR/retention anonymisation write
 * (KBS-30), which is the one other sanctioned update path
 * (spec/data-model). `wedding_date` is a plain DATE, never a timestamp —
 * a timestamp shifts a day for an overseas bride (decision/lead-time-rule
 * §2.2). `token_hash` is the SHA-256 of the 256-bit short-link token;
 * the plaintext token is never stored (decision/enquiry-link).
 *
 * Indexed on `wedding_date` (the inbox's default sort) and on
 * `created_at`/`source` (the dashboard's monthly + source-split
 * aggregates, decision/analytics-attribution §2.4). Retention is
 * indefinite (answer/data-privacy), so this table has no ceiling and a
 * sequential scan never becomes acceptable again — these indexes are
 * not optional.
 */
export const enquiries = pgTable(
  "enquiries",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    reference: text("reference").notNull(),
    tokenHash: text("token_hash").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    contactNumber: text("contact_number"),
    email: text("email"),
    weddingDate: date("wedding_date", { mode: "string" }).notNull(),
    message: text("message"),
    source: text("source").notNull(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    referrerHost: text("referrer_host"),
    chatChannelChosen: text("chat_channel_chosen"),
    leadTimeBandShown: text("lead_time_band_shown").notNull(),
    leadTimeNoticeShown: text("lead_time_notice_shown").notNull(),
    status: text("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("enquiries_reference_idx").on(table.reference),
    uniqueIndex("enquiries_token_hash_idx").on(table.tokenHash),
    index("enquiries_wedding_date_idx").on(table.weddingDate),
    index("enquiries_created_at_idx").on(table.createdAt),
    index("enquiries_source_idx").on(table.source),
    check(
      "enquiries_source_enum_check",
      sql`${table.source} IN ('social', 'search', 'referral', 'direct')`,
    ),
    check(
      "enquiries_chat_channel_enum_check",
      sql`${table.chatChannelChosen} IS NULL OR ${table.chatChannelChosen} IN ('messenger', 'whatsapp', 'viber')`,
    ),
    check(
      "enquiries_lead_time_band_enum_check",
      sql`${table.leadTimeBandShown} IN ('comfortable', 'rush', 'in_stock_only')`,
    ),
    check("enquiries_status_enum_check", sql`${table.status} IN ('new', 'read', 'archived')`),
  ],
);
