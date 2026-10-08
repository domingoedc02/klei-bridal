-- Migration 2/4 (KBS-9-2): enquiries and the immutable gown snapshot.
--
-- `enquiries` is immutable once created — the only mutable column is
-- `status` (plus the GDPR/retention anonymisation write, KBS-30, which
-- clears first_name/last_name/contact_number/email/message to NULL;
-- every personal-data column is therefore nullable here even though the
-- enquiry form itself requires them at submission time).
--
-- `wedding_date` is a plain DATE, never a timestamp — a timestamp
-- shifts a day for an overseas bride (decision/lead-time-rule §2.2).
--
-- `enquiry_gowns` is the reason the enquiry is immutable: gown name and
-- price are snapshotted AS AT SUBMISSION, in the same transaction as
-- the enquiry insert. A later price edit on `gowns` must never rewrite
-- what a bride was actually shown.
--
-- Retention is indefinite (answer/data-privacy), so this table has no
-- ceiling and a sequential scan never becomes acceptable again — the
-- indexes on wedding_date / created_at / source below back the inbox's
-- default sort and the dashboard's monthly + source-split aggregates
-- and are not optional.
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"token_hash" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"contact_number" text,
	"email" text,
	"wedding_date" date NOT NULL,
	"message" text,
	"source" text NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"referrer_host" text,
	"chat_channel_chosen" text,
	"lead_time_band_shown" text NOT NULL,
	"lead_time_notice_shown" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enquiries_source_enum_check" CHECK ("enquiries"."source" IN ('social', 'search', 'referral', 'direct')),
	CONSTRAINT "enquiries_chat_channel_enum_check" CHECK ("enquiries"."chat_channel_chosen" IS NULL OR "enquiries"."chat_channel_chosen" IN ('messenger', 'whatsapp', 'viber')),
	CONSTRAINT "enquiries_lead_time_band_enum_check" CHECK ("enquiries"."lead_time_band_shown" IN ('comfortable', 'rush', 'in_stock_only')),
	CONSTRAINT "enquiries_status_enum_check" CHECK ("enquiries"."status" IN ('new', 'read', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "enquiry_gowns" (
	"enquiry_id" uuid NOT NULL,
	"gown_id" uuid NOT NULL,
	"gown_name_snapshot" text NOT NULL,
	"price_minor_snapshot" bigint,
	"price_status_snapshot" text NOT NULL,
	"currency_snapshot" char(3) NOT NULL,
	CONSTRAINT "enquiry_gowns_enquiry_id_gown_id_pk" PRIMARY KEY("enquiry_id","gown_id")
);
--> statement-breakpoint
ALTER TABLE "enquiry_gowns" ADD CONSTRAINT "enquiry_gowns_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- RESTRICT, not CASCADE: a gown in an enquiry's history cannot vanish
-- silently from under the audit trail (spec/data-model).
ALTER TABLE "enquiry_gowns" ADD CONSTRAINT "enquiry_gowns_gown_id_gowns_id_fk" FOREIGN KEY ("gown_id") REFERENCES "public"."gowns"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "enquiries_reference_idx" ON "enquiries" USING btree ("reference");
--> statement-breakpoint
CREATE UNIQUE INDEX "enquiries_token_hash_idx" ON "enquiries" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "enquiries_wedding_date_idx" ON "enquiries" USING btree ("wedding_date");
--> statement-breakpoint
CREATE INDEX "enquiries_created_at_idx" ON "enquiries" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "enquiries_source_idx" ON "enquiries" USING btree ("source");
