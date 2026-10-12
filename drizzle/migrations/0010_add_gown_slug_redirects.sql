-- KBS-15-1: preserve old gown URLs after an operational slug rename.
CREATE TABLE "gown_slug_redirects" (
  "old_slug" text PRIMARY KEY NOT NULL,
  "gown_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gown_slug_redirects_gown_id_gowns_id_fk"
    FOREIGN KEY ("gown_id") REFERENCES "public"."gowns"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "gown_slug_redirects_gown_id_idx"
  ON "gown_slug_redirects" USING btree ("gown_id");
