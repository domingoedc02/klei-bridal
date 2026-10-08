-- Migration 1/4 (KBS-9-1): vocabulary tables and gowns.
--
-- `silhouettes`/`materials`/`collections` are ROWS, never enums
-- (decision/category-vocabulary) — the client edits them. Each carries a
-- case-insensitive unique index on the trimmed name, enforced HERE in
-- the database, not only in application code: two staff adding "Lace"
-- and "lace" in the same second during a catalogue load is the exact
-- race an application-level check cannot prevent.
--
-- `pg_trgm` backs the near-duplicate-tag warning (similarity() > 0.6,
-- decision/category-vocabulary) and must exist before the trigram GIN
-- indexes below — created in this, the first migration, per spec/setup.
--
-- `gowns.created_by`/`updated_by` and `gown_images.uploaded_by`, and the
-- vocabulary tables' own `created_by`/`updated_by`, are declared here as
-- plain nullable uuid columns WITHOUT a foreign-key constraint yet,
-- because `staff_users` does not exist until migration 0003
-- (KBS-9-3, landed early on purpose — it is the hard blocker on
-- KBS-27). This is the backward-compatible add-nullable -> backfill ->
-- constrain pattern (spec/conventions): migration 0003 adds the
-- deferred FK constraints once the referenced table exists. Nothing
-- here is ever dropped or renamed to get there.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "silhouettes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gowns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"silhouette_id" uuid,
	"price_minor" bigint,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"price_status" text DEFAULT 'on_request' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_in_stock" boolean DEFAULT false NOT NULL,
	"hero_image_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gowns_price_status_check" CHECK ("gowns"."price_status" NOT IN ('priced') OR ("gowns"."price_minor" IS NOT NULL AND "gowns"."price_minor" > 0)),
	CONSTRAINT "gowns_price_status_enum_check" CHECK ("gowns"."price_status" IN ('priced', 'on_request', 'unlisted')),
	CONSTRAINT "gowns_status_enum_check" CHECK ("gowns"."status" IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "gown_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gown_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"is_hero" boolean DEFAULT false NOT NULL,
	"alt_text" text,
	"original_path" text NOT NULL,
	"derivatives" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lqip" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gown_materials" (
	"gown_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	CONSTRAINT "gown_materials_gown_id_material_id_pk" PRIMARY KEY("gown_id","material_id")
);
--> statement-breakpoint
CREATE TABLE "gown_collections" (
	"gown_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	CONSTRAINT "gown_collections_gown_id_collection_id_pk" PRIMARY KEY("gown_id","collection_id")
);
--> statement-breakpoint
-- Foreign keys that resolve entirely within this migration.
ALTER TABLE "gowns" ADD CONSTRAINT "gowns_silhouette_id_silhouettes_id_fk" FOREIGN KEY ("silhouette_id") REFERENCES "public"."silhouettes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gowns" ADD CONSTRAINT "gowns_hero_image_id_gown_images_id_fk" FOREIGN KEY ("hero_image_id") REFERENCES "public"."gown_images"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gown_images" ADD CONSTRAINT "gown_images_gown_id_gowns_id_fk" FOREIGN KEY ("gown_id") REFERENCES "public"."gowns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gown_materials" ADD CONSTRAINT "gown_materials_gown_id_gowns_id_fk" FOREIGN KEY ("gown_id") REFERENCES "public"."gowns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gown_materials" ADD CONSTRAINT "gown_materials_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gown_collections" ADD CONSTRAINT "gown_collections_gown_id_gowns_id_fk" FOREIGN KEY ("gown_id") REFERENCES "public"."gowns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "gown_collections" ADD CONSTRAINT "gown_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Case-insensitive uniqueness per vocabulary table (the database-level
-- guard, not just application validation).
CREATE UNIQUE INDEX "silhouettes_name_lower_trim_idx" ON "silhouettes" USING btree (lower(trim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX "silhouettes_slug_idx" ON "silhouettes" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "silhouettes_name_trgm_idx" ON "silhouettes" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "materials_name_lower_trim_idx" ON "materials" USING btree (lower(trim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX "materials_slug_idx" ON "materials" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "materials_name_trgm_idx" ON "materials" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "collections_name_lower_trim_idx" ON "collections" USING btree (lower(trim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX "collections_slug_idx" ON "collections" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "collections_name_trgm_idx" ON "collections" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX "gowns_slug_idx" ON "gowns" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "gowns_status_idx" ON "gowns" USING btree ("status");
--> statement-breakpoint
-- Backs the catalogue's "available now" badge/toggle without a
-- full-table scan as the catalogue grows (decision/stock-and-rush §5 —
-- a badge plus one toggle, not a fourth filter axis).
CREATE INDEX "gowns_in_stock_published_idx" ON "gowns" USING btree ("is_in_stock") WHERE "gowns"."status" = 'published' AND "gowns"."is_in_stock";
--> statement-breakpoint
CREATE UNIQUE INDEX "gown_images_gown_id_sort_order_idx" ON "gown_images" USING btree ("gown_id","sort_order");
--> statement-breakpoint
-- At most one hero image per gown, enforced in the database rather than
-- by an application-level "unset the old hero, set the new one" race.
CREATE UNIQUE INDEX "gown_images_one_hero_per_gown_idx" ON "gown_images" USING btree ("gown_id") WHERE "gown_images"."is_hero";
