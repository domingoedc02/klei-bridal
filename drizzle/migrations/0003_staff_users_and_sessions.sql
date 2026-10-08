-- Migration 3/4 (KBS-9-3): staff_users and sessions — landed early among
-- these four on purpose, because it is a HARD BLOCKER on KBS-27 (the
-- session mechanism is unbuildable without it).
--
-- `staff_users` rows are NEVER deleted — a leaver is disabled
-- (`is_active=false`), so the audit trail stays attributable
-- (spec/data-model, spec/security).
--
-- `sessions.token_hash` is the SHA-256 of the 256-bit random session
-- cookie value; the raw token is NEVER stored, so a database or backup
-- disclosure yields no replayable session. `token_hash` MUST be
-- indexed (it is, below) — the lookup runs on every authenticated
-- request:
--
--   token_hash = sha256(cookie) AND revoked_at IS NULL
--     AND expires_at > now() AND staff_user.is_active = true
--
-- That join against `is_active` is the entire mechanism that makes
-- disabling a leaver's account take effect on their very next request
-- rather than at token expiry — it is why Auth.js's non-revocable JWT
-- was rejected (spec/security), and it is only cheap because the index
-- exists. DO NOT reintroduce Auth.js or any JWT scheme here.
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_lower_idx" ON "staff_users" USING btree (lower("email"));
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "sessions_staff_user_id_idx" ON "sessions" USING btree ("staff_user_id");
--> statement-breakpoint
-- Deferred foreign keys from migration 0001 (add-nullable -> backfill ->
-- constrain, spec/conventions): those columns existed as plain nullable
-- uuid since `staff_users` did not exist yet. Constraining them now is
-- backward-compatible — no table was dropped or renamed to get here,
-- and a code rollback to before this migration still finds columns of
-- the same shape, just without the FK.
ALTER TABLE "silhouettes" ADD CONSTRAINT "silhouettes_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "silhouettes" ADD CONSTRAINT "silhouettes_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gowns" ADD CONSTRAINT "gowns_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gowns" ADD CONSTRAINT "gowns_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gown_images" ADD CONSTRAINT "gown_images_uploaded_by_staff_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
