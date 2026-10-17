-- KBS-88: taxonomy aliases. One target row per old slug; target_id points
-- directly at a live vocabulary row so aliases cannot chain or loop.
CREATE TABLE "taxonomy_slug_redirects" (
  "vocabulary" text NOT NULL,
  "old_slug" text NOT NULL,
  "target_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "taxonomy_slug_redirects_pk" PRIMARY KEY ("vocabulary", "old_slug"),
  CONSTRAINT "taxonomy_slug_redirects_vocabulary_check" CHECK ("vocabulary" IN ('collections', 'silhouettes', 'materials')),
  CONSTRAINT "taxonomy_slug_redirects_slug_check" CHECK ("old_slug" ~ '^[a-z0-9-]{1,80}$')
);
--> statement-breakpoint
CREATE INDEX "taxonomy_slug_redirects_target_idx"
  ON "taxonomy_slug_redirects" USING btree ("vocabulary", "target_id");
