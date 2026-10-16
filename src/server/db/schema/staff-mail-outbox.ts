import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { generateId } from "../uuid";
import { passwordResetTokens } from "./password-reset-tokens";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const staffMailOutbox = pgTable(
  "staff_mail_outbox",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => passwordResetTokens.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseId: text("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    payload: bytea("payload"),
    keyVersion: integer("key_version").notNull().default(1),
    lastErrorCode: text("last_error_code"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("staff_mail_outbox_idempotency_key_idx").on(table.idempotencyKey),
    index("staff_mail_outbox_pending_idx").on(table.status, table.availableAt),
    check(
      "staff_mail_outbox_status_check",
      sql`${table.status} IN ('pending', 'in_flight', 'sent', 'failed', 'cancelled')`,
    ),
  ],
);
