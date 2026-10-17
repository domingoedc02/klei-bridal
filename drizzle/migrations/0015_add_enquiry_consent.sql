-- KBS-30-1: record what a bride agreed to and when. Nullable: rows created before
-- the consent checkbox existed have no consent record, and must stay valid.
ALTER TABLE "enquiries"
  ADD COLUMN "consent_given_at" timestamp with time zone,
  ADD COLUMN "consent_notice_version" text;
