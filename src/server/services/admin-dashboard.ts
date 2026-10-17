import "server-only";

import { and, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { db as defaultDb, type Database } from "@/server/db/client";
import { enquiries, enquiryGowns } from "@/server/db/schema";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 24;

export const dashboardQuerySchema = z
  .object({
    from: z.string().regex(MONTH, "Expected YYYY-MM.").optional(),
    to: z.string().regex(MONTH, "Expected YYYY-MM.").optional(),
  })
  .superRefine(({ from, to }, context) => {
    if ((from === undefined) !== (to === undefined)) {
      context.addIssue({ code: "custom", message: "from and to must be provided together." });
      return;
    }
    if (!from || !to) return;
    const monthCount =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) - Number(from.slice(5, 7));
    if (monthCount < 1) {
      context.addIssue({ code: "custom", message: "to must be after from." });
    } else if (monthCount > MAX_MONTHS) {
      context.addIssue({ code: "custom", message: `Dashboard range cannot exceed ${MAX_MONTHS} months.` });
    }
  });

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

type MonthRange = {
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
  months: string[];
};

type CountRow = { month: string; value: number };
type SplitRow = { month: string; key: string | null; value: number };
type GownRow = { gownId: string; gownName: string; value: number };

const monthDate = (month: string) => {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, monthNumber - 1, 1));
};

const monthText = (date: Date) => date.toISOString().slice(0, 7);

const addMonths = (date: Date, count: number) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));

export function resolveDashboardRange(query: DashboardQuery = {}, now = new Date()): MonthRange {
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fromDate = query.from ? monthDate(query.from) : addMonths(current, -1);
  const toDate = query.to ? monthDate(query.to) : addMonths(current, 1);
  const months: string[] = [];

  for (let cursor = fromDate; cursor < toDate; cursor = addMonths(cursor, 1)) {
    months.push(monthText(cursor));
    if (months.length > MAX_MONTHS) {
      throw new RangeError(`Dashboard range cannot exceed ${MAX_MONTHS} months.`);
    }
  }
  if (fromDate >= toDate || months.length === 0) {
    throw new RangeError("Dashboard range must contain at least one month.");
  }

  return {
    from: monthText(fromDate),
    to: monthText(toDate),
    fromDate,
    toDate,
    months,
  };
}

const sourceKeys = ["social", "search", "direct", "referral"] as const;
const chatKeys = ["messenger", "whatsapp", "viber", "none"] as const;

const zeroSplit = <T extends readonly string[]>(keys: T): Record<T[number], number> =>
  Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;

export type DashboardResponse = ReturnType<typeof buildDashboard>;

export function buildDashboard(
  range: MonthRange,
  totals: CountRow[],
  sources: SplitRow[],
  chats: SplitRow[],
  gowns: GownRow[],
) {
  const totalByMonth = new Map(totals.map((row) => [row.month, Number(row.value)]));
  const sourceByMonth = new Map<string, Record<string, number>>();
  const chatByMonth = new Map<string, Record<string, number>>();

  for (const row of sources) {
    const split = sourceByMonth.get(row.month) ?? zeroSplit(sourceKeys);
    if (row.key && sourceKeys.includes(row.key as (typeof sourceKeys)[number])) {
      split[row.key as (typeof sourceKeys)[number]] = Number(row.value);
    }
    sourceByMonth.set(row.month, split);
  }
  for (const row of chats) {
    const split = chatByMonth.get(row.month) ?? zeroSplit(chatKeys);
    const key = row.key ?? "none";
    if (chatKeys.includes(key as (typeof chatKeys)[number])) {
      split[key as (typeof chatKeys)[number]] = Number(row.value);
    }
    chatByMonth.set(row.month, split);
  }

  return {
    range: { from: range.from, to: range.to },
    months: range.months.map((month) => ({
      month,
      enquiry_count: totalByMonth.get(month) ?? 0,
      source_split: sourceByMonth.get(month) ?? zeroSplit(sourceKeys),
      chat_channel_split: chatByMonth.get(month) ?? zeroSplit(chatKeys),
    })),
    send_my_list_sends: {
      available: false,
      count: null,
      reason: "No server-side send-my-list event table exists; mail delivery rows are not analytics events.",
    },
    most_requested_gowns: gowns.map((row) => ({
      gown_id: row.gownId,
      gown_name: row.gownName,
      request_count: Number(row.value),
    })),
    attribution_note:
      "Source attribution reflects persisted enquiry values. Current enquiry submission defaults source to direct until upstream UTM/referrer attribution lands.",
    most_requested_note: "Counts enquiry gown selections only. Device-local favourites and generic mail delivery rows are excluded.",
  };
}

export async function getAdminDashboard(
  query: DashboardQuery = {},
  db: Database = defaultDb,
  now = new Date(),
) {
  const range = resolveDashboardRange(query, now);
  const monthExpr = sql<string>`to_char(date_trunc('month', ${enquiries.createdAt}), 'YYYY-MM')`;
  const [totals, sources, chats, gowns] = await Promise.all([
    db
      .select({ month: monthExpr, value: sql<number>`count(*)::int` })
      .from(enquiries)
      .where(and(gte(enquiries.createdAt, range.fromDate), lt(enquiries.createdAt, range.toDate)))
      .groupBy(monthExpr),
    db
      .select({ month: monthExpr, key: enquiries.source, value: sql<number>`count(*)::int` })
      .from(enquiries)
      .where(and(gte(enquiries.createdAt, range.fromDate), lt(enquiries.createdAt, range.toDate)))
      .groupBy(monthExpr, enquiries.source),
    db
      .select({ month: monthExpr, key: enquiries.chatChannelChosen, value: sql<number>`count(*)::int` })
      .from(enquiries)
      .where(and(gte(enquiries.createdAt, range.fromDate), lt(enquiries.createdAt, range.toDate)))
      .groupBy(monthExpr, enquiries.chatChannelChosen),
    db
      .select({
        gownId: enquiryGowns.gownId,
        gownName: enquiryGowns.gownNameSnapshot,
        value: sql<number>`count(*)::int`,
      })
      .from(enquiryGowns)
      .innerJoin(enquiries, and(
        sql`${enquiryGowns.enquiryId} = ${enquiries.id}`,
        gte(enquiries.createdAt, range.fromDate),
        lt(enquiries.createdAt, range.toDate),
      ))
      .groupBy(enquiryGowns.gownId, enquiryGowns.gownNameSnapshot)
      .orderBy(sql`count(*) DESC`, enquiryGowns.gownNameSnapshot)
      .limit(50),
  ]);

  return buildDashboard(range, totals, sources, chats, gowns);
}
