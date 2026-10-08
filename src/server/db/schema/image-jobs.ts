import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { generateId } from "../uuid";
import { gownImages } from "./gown-images";

/**
 * The bounded encode queue (decision/images §2.3) — Postgres, not Valkey,
 * so a job survives a cache flush. The worker (src/server/worker/,
 * KBS-13) claims rows with `FOR UPDATE SKIP LOCKED`; this schema only
 * needs the status index that query filters on.
 */
export const imageJobs = pgTable(
  "image_jobs",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    gownImageId: uuid("gown_image_id")
      .notNull()
      .references(() => gownImages.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("image_jobs_status_idx").on(table.status),
    check(
      "image_jobs_status_enum_check",
      sql`${table.status} IN ('pending', 'processing', 'done', 'failed')`,
    ),
  ],
);
