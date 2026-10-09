import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { generateId } from "../uuid";
import { staffUsers } from "./staff-users";

/**
 * Emailed staff password-reset bearer tokens. Only SHA-256(token) is stored;
 * the raw token exists only in the post-commit mail payload.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_token_hash_idx").on(table.tokenHash),
    index("password_reset_tokens_staff_user_id_idx").on(table.staffUserId),
    index("password_reset_tokens_active_idx").on(table.staffUserId, table.expiresAt),
  ],
);
