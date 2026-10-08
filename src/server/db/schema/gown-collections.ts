import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

import { collections } from "./collections";
import { gowns } from "./gowns";

// See gown-materials.ts for the shape and rationale.
export const gownCollections = pgTable(
  "gown_collections",
  {
    gownId: uuid("gown_id")
      .notNull()
      .references(() => gowns.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.gownId, table.collectionId] })],
);
