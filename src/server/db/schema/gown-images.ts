import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { generateId } from "../uuid";
import { gowns } from "./gowns";
import { staffUsers } from "./staff-users";

/**
 * One row per photograph. `original_path` is never served to a browser —
 * only `derivatives` (the generated-width manifest) is (spec/architecture,
 * decision/images). `is_hero` is enforced single-true per gown by the
 * partial unique index below, not by application logic — the same
 * "enforce in the database" rule that protects vocabulary names.
 */
export const gownImages = pgTable(
  "gown_images",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    gownId: uuid("gown_id")
      .notNull()
      .references(() => gowns.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    isHero: boolean("is_hero").notNull().default(false),
    altText: text("alt_text"),
    originalPath: text("original_path").notNull(),
    derivatives: jsonb("derivatives").notNull().default({}),
    lqip: text("lqip"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => staffUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gown_images_gown_id_sort_order_idx").on(table.gownId, table.sortOrder),
    // Partial unique index: at most one hero row per gown, enforced in
    // the database rather than by an application-level "unset the old
    // hero, set the new one" race.
    uniqueIndex("gown_images_one_hero_per_gown_idx")
      .on(table.gownId)
      .where(sql`${table.isHero}`),
  ],
);
