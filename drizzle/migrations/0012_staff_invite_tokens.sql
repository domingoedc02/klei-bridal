-- KBS-123: passwordless invite tokens use same table as reset tokens.
ALTER TABLE "staff_users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD COLUMN "kind" text NOT NULL DEFAULT 'reset';
--> statement-breakpoint
ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_kind_check"
  CHECK ("kind" IN ('invite', 'reset'));
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_active_kind_idx"
  ON "password_reset_tokens" ("staff_user_id", "kind")
  WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
