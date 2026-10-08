import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { generateId } from "../uuid";
import { gownImages } from "./gown-images";
import { silhouettes } from "./silhouettes";
import { staffUsers } from "./staff-users";

/**
 * The aggregate root (spec/data-model). `price_status`/`status` are
 * explicit text enums (`priced|on_request|unlisted`, `draft|published|
 * archived`) rather than booleans or a soft-delete flag — the
 * application reasons about these as named states, not bit flags.
 *
 * `is_in_stock` (decision/stock-and-rush) is independent of both —
 * any combination is valid. Default MUST be false: a permissive default
 * turns an exception (a gown genuinely in stock) into an accidental
 * promise across the whole catalogue the day this ships.
 */
export const gowns = pgTable(
  "gowns",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    silhouetteId: uuid("silhouette_id").references(() => silhouettes.id, {
      onDelete: "restrict",
    }),
    priceMinor: bigint("price_minor", { mode: "number" }),
    currency: char("currency", { length: 3 }).notNull().default("PHP"),
    priceStatus: text("price_status").notNull().default("on_request"),
    status: text("status").notNull().default("draft"),
    isInStock: boolean("is_in_stock").notNull().default(false),
    heroImageId: uuid("hero_image_id").references((): AnyPgColumn => gownImages.id),
    createdBy: uuid("created_by").references(() => staffUsers.id),
    updatedBy: uuid("updated_by").references(() => staffUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gowns_slug_idx").on(table.slug),
    index("gowns_status_idx").on(table.status),
    // Backs the catalogue's "available now" badge/toggle without a
    // full-table scan as the catalogue grows (decision/stock-and-rush §5
    // — a badge plus one toggle, not a fourth filter axis).
    index("gowns_in_stock_published_idx")
      .on(table.isInStock)
      .where(sql`${table.status} = 'published' AND ${table.isInStock}`),
    // The backstop that stops a published gown with no price — the
    // handler validates this too (422), but application-level checks
    // race, so the CHECK is the real guarantee.
    check(
      "gowns_price_status_check",
      sql`${table.priceStatus} NOT IN ('priced') OR (${table.priceMinor} IS NOT NULL AND ${table.priceMinor} > 0)`,
    ),
    check(
      "gowns_price_status_enum_check",
      sql`${table.priceStatus} IN ('priced', 'on_request', 'unlisted')`,
    ),
    check("gowns_status_enum_check", sql`${table.status} IN ('draft', 'published', 'archived')`),
  ],
);
