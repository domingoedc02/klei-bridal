import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { generateId } from "../uuid";
import { gowns } from "./gowns";
import { staffUsers } from "./staff-users";

/**
 * Append-only, like `audit_log` (same DB-grant enforcement — see
 * drizzle/migrations/0004). A distinct business record, not a duplicate
 * of the audit log: prices are public, so a bride who screenshots one
 * needs the studio to be answerable with what it said and when. Written
 * in the same transaction as the price change on `gowns`, alongside a
 * `price.change` `audit_log` row (spec/data-model).
 */
export const priceHistory = pgTable(
  "price_history",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    gownId: uuid("gown_id")
      .notNull()
      .references(() => gowns.id, { onDelete: "cascade" }),
    oldPriceMinor: bigint("old_price_minor", { mode: "number" }),
    newPriceMinor: bigint("new_price_minor", { mode: "number" }),
    oldStatus: text("old_status").notNull(),
    newStatus: text("new_status").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => staffUsers.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("price_history_gown_id_idx").on(table.gownId)],
);
