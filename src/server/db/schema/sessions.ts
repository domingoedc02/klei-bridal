import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { generateId } from "../uuid";
import { staffUsers } from "./staff-users";

/**
 * The entire reason Auth.js's Credentials+JWT path was rejected
 * (spec/security, spec/architecture open item 2): a server-owned session
 * row that can be revoked immediately, looked up on every authenticated
 * request as:
 *
 *   token_hash = sha256(cookie) AND revoked_at IS NULL
 *     AND expires_at > now() AND staff_user.is_active = true
 *
 * `token_hash` is the SHA-256 of the 256-bit raw cookie value — the raw
 * token is NEVER stored, so a DB/backup disclosure yields no replayable
 * session. It MUST be indexed: this lookup runs on every admin request,
 * and the `staff_user.is_active` join is the entire mechanism that makes
 * disabling a leaver's account take effect on their very next request
 * rather than at token expiry.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_staff_user_id_idx").on(table.staffUserId),
  ],
);
