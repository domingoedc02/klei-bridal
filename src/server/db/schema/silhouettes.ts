import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { generateId } from "../uuid";
import { staffUsers } from "./staff-users";

/**
 * A vocabulary table — a row, never an enum (decision/category-vocabulary):
 * the client edits these. Silhouettes, materials and collections share
 * this exact shape; kept as three files (not one shared factory) so each
 * matches its own join table 1:1 and a reviewer can read one in
 * isolation (spec/file-structure naming convention).
 */
export const silhouettes = pgTable(
  "silhouettes",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => staffUsers.id),
    updatedBy: uuid("updated_by").references(() => staffUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive uniqueness enforced IN THE DATABASE, not only in
    // application code — two staff adding "Lace" and "lace" in the same
    // second during a catalogue load is the exact race this prevents.
    uniqueIndex("silhouettes_name_lower_trim_idx").on(sql`lower(trim(${table.name}))`),
    uniqueIndex("silhouettes_slug_idx").on(table.slug),
  ],
);
