import { bigint, char, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

import { enquiries } from "./enquiries";
import { gowns } from "./gowns";

/**
 * The join AND the reason the enquiry is immutable: gown name/price are
 * snapshotted here at submission, in the same transaction as the
 * enquiry insert, so a later price edit never rewrites what a bride was
 * actually shown (spec/data-model, decision/pricing-display §2.3). The
 * FK to `gowns` is kept for staff click-through, not as the source of
 * truth for what she saw.
 */
export const enquiryGowns = pgTable(
  "enquiry_gowns",
  {
    enquiryId: uuid("enquiry_id")
      .notNull()
      .references(() => enquiries.id, { onDelete: "cascade" }),
    gownId: uuid("gown_id")
      .notNull()
      .references(() => gowns.id, { onDelete: "restrict" }),
    gownNameSnapshot: text("gown_name_snapshot").notNull(),
    priceMinorSnapshot: bigint("price_minor_snapshot", { mode: "number" }),
    priceStatusSnapshot: text("price_status_snapshot").notNull(),
    currencySnapshot: char("currency_snapshot", { length: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.enquiryId, table.gownId] })],
);
