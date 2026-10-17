-- KBS-16: generic encrypted transactional mail outbox for public mail jobs.
CREATE TABLE "mail_outbox" (
  "id" uuid PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_id" text,
  "lease_until" timestamp with time zone,
  "provider_message_id" text,
  "payload" bytea,
  "key_version" integer DEFAULT 1 NOT NULL,
  "last_error_code" text,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mail_outbox_status_check" CHECK ("mail_outbox"."status" IN ('pending', 'in_flight', 'sent', 'failed', 'cancelled')),
  CONSTRAINT "mail_outbox_idempotency_key_unique" UNIQUE("idempotency_key")
);
CREATE INDEX "mail_outbox_pending_idx" ON "mail_outbox" USING btree ("status", "available_at");
