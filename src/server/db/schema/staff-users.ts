import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { generateId } from "../uuid";

/**
 * Staff accounts. Rows are NEVER deleted — disabling (`is_active=false`)
 * preserves the audit trail's actor reference (spec/data-model,
 * spec/security). No Auth.js, no JWT anywhere near this table; its only
 * consumer is argon2id verification plus the `sessions` join below.
 */
export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    name: text("name").notNull(),
    email: text("email").notNull(),
    // NULL means account is passwordless until invite redemption (KBS-123).
    passwordHash: text("password_hash"),
    tempPasswordExpiresAt: timestamp("temp_password_expires_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Case-insensitive — "Staff@kleibridal.com" and "staff@kleibridal.com"
    // must collide, or login-by-email has a silent duplicate-account bug.
    uniqueIndex("staff_users_email_lower_idx").on(sql`lower(${table.email})`),
  ],
);
