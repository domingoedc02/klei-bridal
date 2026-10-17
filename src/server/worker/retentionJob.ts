import "server-only";
import { and, inArray, isNotNull, lt } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { enquiries, settings } from "@/server/db/schema";
import { logger } from "@/server/observability/logger";
import { captureError } from "@/server/observability/sentry";
import { PipelineError } from "@/server/pipeline/errors";
import { anonymiseEnquiry } from "@/server/services/enquiry-erasure";

/**
 * KBS-30-3. Ships DISABLED: the client chose indefinite retention
 * (answer/data-privacy). It is the switch they flip if that changes, so it
 * must keep working. Calls the one shared erase, trigger "retention"; a 409
 * (erased meanwhile) is a skip. Never hard-deletes, so counts never shrink.
 * ponytail: "last activity" is created_at (no updated_at on enquiries); add
 * a last_activity_at column if status changes should extend retention.
 */
const BATCH = 200;
const RUN_MS = 24 * 60 * 60_000;
const RUN_AFTER_BOOT_MS = 5 * 60_000;

export type RetentionResult =
  | { ran: false; reason: "disabled" | "invalid_months" }
  | { ran: true; erased: number; skipped: number; more: boolean };

export async function runRetention(
  deps: { db?: Database; now?: Date } = {},
): Promise<RetentionResult> {
  const db = deps.db ?? defaultDb;
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ["retention_enabled", "retention_months"]));
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Strictly `true`: anything else (missing, "true", 1) is off.
  if (v.retention_enabled !== true) {
    logger.info({ event: "retention_disabled" }, "retention job disabled, no rows touched");
    return { ran: false, reason: "disabled" };
  }
  const months = v.retention_months;
  if (typeof months !== "number" || !Number.isInteger(months) || months < 1) {
    logger.warn({ event: "retention_invalid_months" }, "retention enabled but months invalid");
    return { ran: false, reason: "invalid_months" };
  }

  const cutoff = new Date(deps.now ?? new Date());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);

  const due = await db
    .select({ id: enquiries.id })
    .from(enquiries)
    .where(and(lt(enquiries.createdAt, cutoff), isNotNull(enquiries.email)))
    .orderBy(enquiries.createdAt)
    .limit(BATCH + 1);

  let erased = 0;
  let skipped = 0;
  for (const { id } of due.slice(0, BATCH)) {
    try {
      await db.transaction((tx) =>
        anonymiseEnquiry(tx as unknown as Database, id, {
          actorUserId: null,
          trigger: "retention",
          reason: "retention_policy",
        }),
      );
      erased++;
    } catch (error) {
      if (error instanceof PipelineError && error.status === 409) skipped++;
      else throw error;
    }
  }
  logger.info({ event: "retention_run", erased, skipped, months }, "retention job ran");
  return { ran: true, erased, skipped, more: due.length > BATCH };
}

let started = false;
export function startRetentionJob() {
  if (started) return;
  started = true;
  const run = () =>
    void runRetention().catch((error: unknown) => {
      logger.error({ err: error }, "retention_job_failed");
      captureError(error);
    });
  setTimeout(run, RUN_AFTER_BOOT_MS).unref();
  setInterval(run, RUN_MS).unref();
}
