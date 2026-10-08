import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

import { gowns } from "./gowns";
import { materials } from "./materials";

/**
 * Many-to-many join. Composite PK (not a surrogate id + a separate
 * unique index) — duplicate tagging is impossible by construction, not
 * by an extra constraint someone could drop later. `ON DELETE RESTRICT`
 * on `material_id`: a tag in use cannot vanish silently from under a
 * published gown (spec/data-model).
 */
export const gownMaterials = pgTable(
  "gown_materials",
  {
    gownId: uuid("gown_id")
      .notNull()
      .references(() => gowns.id, { onDelete: "cascade" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.gownId, table.materialId] })],
);
