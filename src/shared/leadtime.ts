// Pure lead-time band calculation, run on both client (for immediacy)
// and server (for the record) — never the form's error machinery
// (decision/lead-time-rule §2.3). Same function both sides, so the band
// the bride sees and the band stored on her enquiry cannot drift (AC-ENQ-13).

import { daysBetween } from "./dates";

export type LeadTimeBand = "comfortable" | "rush" | "in_stock_only";

export interface LeadTimeRule {
  comfortableWeeks: number;
  rushFloorWeeks: number;
}

/** Seed values (decision/lead-time-rule, confirmed 2–3 months). Used only when settings are missing or invalid. */
export const DEFAULT_LEAD_TIME_RULE: LeadTimeRule = { comfortableWeeks: 13, rushFloorWeeks: 5 };

/**
 * Fallback copy so an unwritten or blank setting never renders blank (AC-ENQ-15).
 * Mirrors drizzle/seed NOTICE_COPY. `comfortable` shows no notice (ADR §2.1).
 */
export const DEFAULT_NOTICE_COPY: Record<Exclude<LeadTimeBand, "comfortable">, string> = {
  rush: "Your wedding date is coming up — rush production may be possible. We'll confirm availability when we reply to your enquiry.",
  in_stock_only:
    "Your wedding date is close. Only in-stock gowns can be guaranteed in time — we'll let you know what's possible when we reply.",
};

/**
 * Boundaries follow the AC-ENQ-13 sweep exactly: exactly at the rush floor
 * is still in-stock-only; exactly at the comfortable threshold is comfortable.
 * `today` and `weddingDate` are YYYY-MM-DD; `today` is the studio's (Asia/Manila).
 */
export function leadTimeBand(weddingDate: string, today: string, rule: LeadTimeRule): LeadTimeBand {
  const days = daysBetween(today, weddingDate);
  if (days >= rule.comfortableWeeks * 7) return "comfortable";
  if (days > rule.rushFloorWeeks * 7) return "rush";
  return "in_stock_only";
}
