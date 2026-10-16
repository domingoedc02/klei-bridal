-- KBS-123-3: encrypted staff invite mail outbox.
CREATE TABLE "staff_mail_outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "provider_message_id" text,
  "payload" bytea,
  "key_version" integer DEFAULT 1 NOT NULL,
  "last_error_code" text,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_id" text,
  "lease_until" timestamp with time zone,
  CONSTRAINT "staff_mail_outbox_status_check" CHECK ("status" IN ('pending', 'in_flight', 'sent', 'failed', 'cancelled')),
  CONSTRAINT "staff_mail_outbox_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "password_reset_tokens"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_mail_outbox_idempotency_key_idx" ON "staff_mail_outbox" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "staff_mail_outbox_pending_idx" ON "staff_mail_outbox" ("status", "available_at");
