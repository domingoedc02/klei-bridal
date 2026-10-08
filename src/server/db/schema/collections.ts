import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { generateId } from "../uuid";
import { staffUsers } from "./staff-users";

// See silhouettes.ts for the shared shape and its rationale. Collections
// additionally back the public collection landing pages (KBS-10).
export const collections = pgTable(
  "collections",
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
    uniqueIndex("collections_name_lower_trim_idx").on(sql`lower(trim(${table.name}))`),
    uniqueIndex("collections_slug_idx").on(table.slug),
  ],
);
