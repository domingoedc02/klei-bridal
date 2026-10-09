import { sql } from "drizzle-orm";

import type { Database } from "@/server/db/client";

export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Serializes original-file unlink with gown_images reference insertion.
 * `hashtextextended` gives every content-addressed path a stable advisory key;
 * the transaction-scoped lock remains held until the caller commits.
 */
export async function lockOriginalPath(
  transaction: DatabaseTransaction,
  originalPath: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${originalPath}, 0))`,
  );
}
