import { index, inet, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { generateId } from "../uuid";
import { staffUsers } from "./staff-users";

/**
 * Append-only — enforced at the DATABASE GRANT level (the app's runtime
 * role gets INSERT/SELECT only, no UPDATE/DELETE; see
 * drizzle/migrations/0004_... for the REVOKE/GRANT statements, which
 * Drizzle's schema builder cannot express). With a single staff
 * permission level, this log is the only compensating control
 * (spec/security). `detail` MUST NEVER contain a bride's name, number,
 * email, message or wedding date — log the enquiry `id` only.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid("actor_user_id").references(() => staffUsers.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    detail: jsonb("detail").notNull().default({}),
    /** KBS-62: from clientIp(), via inetOrNull — never a non-IP string. */
    ip: inet("ip"),
  },
  (table) => [
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_actor_occurred_idx").on(table.actorUserId, table.occurredAt),
  ],
);
