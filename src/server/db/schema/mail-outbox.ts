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

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: uuid("id").primaryKey().$defaultFn(generateId),
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
    uniqueIndex("mail_outbox_idempotency_key_idx").on(table.idempotencyKey),
    index("mail_outbox_pending_idx").on(table.status, table.availableAt),
    check(
      "mail_outbox_status_check",
      sql`${table.status} IN ('pending', 'in_flight', 'sent', 'failed', 'cancelled')`,
    ),
  ],
);
