-- KBS-123-3: hold an in-flight lease across provider delivery.
ALTER TABLE "staff_mail_outbox"
  ADD COLUMN "lease_id" text,
  ADD COLUMN "lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "staff_mail_outbox"
  DROP CONSTRAINT "staff_mail_outbox_status_check";
--> statement-breakpoint
ALTER TABLE "staff_mail_outbox"
  ADD CONSTRAINT "staff_mail_outbox_status_check"
  CHECK ("status" IN ('pending', 'in_flight', 'sent', 'failed', 'cancelled'));
