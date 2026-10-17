import { inArray } from "drizzle-orm";
import { z } from "zod";

import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, settings } from "@/server/db/schema";
import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { generateId } from "@/server/db/uuid";
import { invalidateCatalogueCacheAfterCommit } from "@/server/services/catalogueCache";
import { clientIp, inetOrNull } from "@/server/ratelimit/client-ip";
import { isValidTimeZone } from "@/shared/dates";

const SETTING_KEYS = [
  "lead_time_comfortable_weeks",
  "lead_time_rush_floor_weeks",
  "lead_time_notice_copy",
  "studio_timezone",
  "studio_facebook_page",
  "studio_whatsapp_number",
  "studio_viber_number",
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

const HANDLE = /^[A-Za-z0-9.]{5,50}$/;
const PHONE = /^[1-9][0-9]{6,14}$/;
const DEFAULTS = {
  lead_time_comfortable_weeks: 13,
  lead_time_rush_floor_weeks: 5,
  lead_time_notice_copy: {
    comfortable: "",
    rush: "Your wedding date is coming up — rush production may be possible. We'll confirm availability when we reply to your enquiry.",
    in_stock_only:
      "Your wedding date is close. Only in-stock gowns can be guaranteed in time — we'll let you know what's possible when we reply.",
  },
  studio_timezone: "Asia/Manila",
  studio_facebook_page: "",
  studio_whatsapp_number: "",
  studio_viber_number: "",
} as const;

const noticeCopy = z
  .object({
    // Runtime lead-time evaluation keeps comfortable band notice empty; retain
    // editable text for admin/audit compatibility with existing seed data.
    comfortable: z.string().trim().min(1).max(2_000),
    rush: z.string().trim().min(1).max(2_000),
    in_stock_only: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const adminSettingsPatchSchema = z
  .object({
    lead_time_comfortable_weeks: z.number().int().min(1).max(260).optional(),
    lead_time_rush_floor_weeks: z.number().int().min(1).max(260).optional(),
    lead_time_notice_copy: noticeCopy.optional(),
    studio_timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Use a valid IANA timezone.").optional(),
    studio_facebook_page: z.string().trim().max(50).refine((value) => !value || HANDLE.test(value), "Use a valid Messenger page handle.").optional(),
    studio_whatsapp_number: z.string().trim().max(15).refine((value) => !value || PHONE.test(value), "Use a valid WhatsApp number.").optional(),
    studio_viber_number: z.string().trim().max(15).refine((value) => !value || PHONE.test(value), "Use a valid Viber number.").optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one setting.");

export type AdminSettingsPatch = z.infer<typeof adminSettingsPatchSchema>;
export type AdminSettings = {
  lead_time_comfortable_weeks: number;
  lead_time_rush_floor_weeks: number;
  lead_time_notice_copy: {
    comfortable: string;
    rush: string;
    in_stock_only: string;
  };
  studio_timezone: string;
  studio_facebook_page: string;
  studio_whatsapp_number: string;
  studio_viber_number: string;
};

function valueFor(key: SettingKey, value: unknown): AdminSettings[SettingKey] {
  if (key === "lead_time_notice_copy") {
    if (typeof value !== "object" || value === null) return DEFAULTS[key];
    const parsed = noticeCopy.safeParse(value);
    return parsed.success ? parsed.data : DEFAULTS[key];
  }
  if (key === "lead_time_comfortable_weeks" || key === "lead_time_rush_floor_weeks") {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 260
      ? value
      : DEFAULTS[key];
  }
  if (key === "studio_timezone") {
    return typeof value === "string" && isValidTimeZone(value) ? value : DEFAULTS[key];
  }
  if (typeof value !== "string") return DEFAULTS[key];
  return value.trim();
}

function fromRows(rows: Array<{ key: string; value: unknown }>): AdminSettings {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, valueFor(key, values.get(key))]),
  ) as AdminSettings;
}

async function readSettings(tx: Pick<Database, "select"> = defaultDb): Promise<AdminSettings> {
  const rows = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...SETTING_KEYS]));
  return fromRows(rows);
}

function changedKeys(before: AdminSettings, patch: AdminSettingsPatch): SettingKey[] {
  return SETTING_KEYS.filter((key) => {
    const next = patch[key];
    return next !== undefined && JSON.stringify(before[key]) !== JSON.stringify(next);
  });
}

function validateOrdering(values: Pick<AdminSettings, "lead_time_comfortable_weeks" | "lead_time_rush_floor_weeks">) {
  if (values.lead_time_rush_floor_weeks >= values.lead_time_comfortable_weeks) {
    throw new PipelineError(422, "VALIDATION_ERROR", "Rush floor must be less than comfortable lead time.", {
      fields: { lead_time_rush_floor_weeks: "Must be less than comfortable lead time." },
    });
  }
}

export async function getAdminSettings(db: Database = defaultDb): Promise<AdminSettings> {
  return readSettings(db);
}

export async function updateAdminSettings(
  patch: AdminSettingsPatch,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
): Promise<AdminSettings> {
  const result = await db.transaction(async (tx) => {
    const before = await readSettings(tx);
    const next = { ...before, ...patch } as AdminSettings;
    validateOrdering(next);
    const keys = changedKeys(before, patch);
    if (!keys.length) return { settings: before, changed: false };

    const now = new Date();
    for (const key of keys) {
      const value = next[key];
      await tx
        .insert(settings)
        .values({ key, value, updatedBy: actor.staff.id, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedBy: actor.staff.id, updatedAt: now },
        });
      await tx.insert(auditLog).values({
        id: generateId(),
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "settings.update",
        entityType: "setting",
        entityId: generateId(),
        detail: { field: key, old_value: before[key], new_value: value },
        ip: inetOrNull(ip),
      });
    }
    return { settings: next, changed: true };
  });
  if (result.changed) invalidateCatalogueCacheAfterCommit();
  return result.settings;
}

export { clientIp };
