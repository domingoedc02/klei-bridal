import { and, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { gowns } from "@/server/db/schema";
import { PipelineError } from "@/server/pipeline/errors";

/**
 * The server-side re-check every write carrying browser-supplied gown ids
 * must call (KBS-11-3): each id must exist AND be published now. A draft,
 * archived or deleted gown is refused as 422 on the field, never trusted.
 */
export async function requirePublishedGowns(
  ids: readonly string[],
  field = "gown_ids",
  db: Database = defaultDb,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: gowns.id })
    .from(gowns)
    .where(and(inArray(gowns.id, [...ids]), eq(gowns.status, "published")));
  const unique = [...new Set(ids)];
  if (rows.length !== unique.length) {
    throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
      fields: { [field]: "One or more gowns are no longer available." },
    });
  }
  return unique;
}
