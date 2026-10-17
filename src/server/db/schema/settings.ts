import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { staffUsers } from "./staff-users";

/**
 * Typed-on-read key/value store. Holds the lead-time window (seeded
 * 13/5 weeks — the client's confirmed 2-3 months, NOT the stale 26/10
 * week figure some early ADRs still carry), notice copy per band,
 * studio chat handles, `studio_timezone` (seeded `Asia/Manila`, labelled
 * an UNCONFIRMED assumption — not stated as fact), and the retention
 * flags (`retention_enabled=false`, `retention_months=null`) — the
 * columns must exist even though the flag ships off, because retention
 * is indefinite by the client's own decision and this is the switch if
 * that ever changes (spec/data-model "Lifecycle & retention").
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => staffUsers.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
