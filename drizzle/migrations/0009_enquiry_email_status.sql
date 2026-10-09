-- KBS-17-2: durable outcome for best-effort post-commit enquiry mail.
ALTER TABLE "enquiries"
  ADD COLUMN "studio_email_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN "bride_email_status" text NOT NULL DEFAULT 'pending';

ALTER TABLE "enquiries"
  ADD CONSTRAINT "enquiries_studio_email_status_enum_check"
    CHECK ("studio_email_status" IN ('pending', 'sent', 'failed'));
ALTER TABLE "enquiries"
  ADD CONSTRAINT "enquiries_bride_email_status_enum_check"
    CHECK ("bride_email_status" IN ('pending', 'sent', 'failed'));
