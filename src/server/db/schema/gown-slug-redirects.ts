import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { gowns } from "./gowns";

/** Retired public gown URLs. An old slug resolves to its gown's current canonical slug. */
export const gownSlugRedirects = pgTable(
  "gown_slug_redirects",
  {
    oldSlug: text("old_slug").primaryKey(),
    gownId: uuid("gown_id")
      .notNull()
      .references(() => gowns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("gown_slug_redirects_gown_id_idx").on(table.gownId)],
);
