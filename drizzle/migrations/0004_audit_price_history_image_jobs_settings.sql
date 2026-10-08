-- Migration 4/4 (KBS-9-4): audit_log, price_history, image_jobs, settings
-- — the tables that make the system accountable, plus the grant-level
-- enforcement that makes "append-only" true rather than merely a
-- convention nobody checks.
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gown_id" uuid NOT NULL,
	"old_price_minor" bigint,
	"new_price_minor" bigint,
	"old_status" text NOT NULL,
	"new_status" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gown_image_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_jobs_status_enum_check" CHECK ("image_jobs"."status" IN ('pending', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_staff_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_gown_id_gowns_id_fk" FOREIGN KEY ("gown_id") REFERENCES "public"."gowns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_actor_user_id_staff_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "image_jobs" ADD CONSTRAINT "image_jobs_gown_image_id_gown_images_id_fk" FOREIGN KEY ("gown_image_id") REFERENCES "public"."gown_images"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX "audit_log_actor_occurred_idx" ON "audit_log" USING btree ("actor_user_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "price_history_gown_id_idx" ON "price_history" USING btree ("gown_id");
--> statement-breakpoint
CREATE INDEX "image_jobs_status_idx" ON "image_jobs" USING btree ("status");
--> statement-breakpoint
-- Append-only, enforced at the DATABASE GRANT level — not merely
-- application discipline. With a single staff permission level
-- (answer/security-compliance), every staff account can read every
-- bride's contact details, and this log is the only compensating
-- control (spec/security). An audit row that can be edited or deleted
-- is not an audit row.
--
-- `kbs_app` is the role the running application connects as. It is
-- created here, idempotently, if it does not already exist; KBS-34
-- (production environment bring-up) sets its password via
-- `ALTER ROLE kbs_app WITH PASSWORD '<from the deploy's own secret
-- store>'` — never in a committed migration — and DATABASE_URL in every
-- real environment must connect AS kbs_app, not as the admin/owner role
-- that runs migrations. REVOKE has no effect on a table's OWNER, so the
-- role distinction is what gives this restriction teeth; flagged to
-- @system-architect and devops in the PR as a KBS-34 dependency.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kbs_app') THEN
		CREATE ROLE kbs_app LOGIN;
	END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO kbs_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kbs_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kbs_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "audit_log" FROM kbs_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "price_history" FROM kbs_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO kbs_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "price_history" TO kbs_app;
