import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Old taxonomy slugs. targetId points directly at a live row, so redirects cannot chain. */
export const taxonomySlugRedirects = pgTable(
  "taxonomy_slug_redirects",
  {
    vocabulary: text("vocabulary").notNull(),
    oldSlug: text("old_slug").notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.vocabulary, table.oldSlug] }),
    index("taxonomy_slug_redirects_target_idx").on(table.vocabulary, table.targetId),
  ],
);
