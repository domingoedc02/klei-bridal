-- KBS-59-1: hashed, single-use, expiring staff password-reset tokens.
CREATE TABLE "password_reset_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "staff_user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "password_reset_tokens_staff_user_id_staff_users_id_fk"
    FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id")
    ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_idx"
  ON "password_reset_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_staff_user_id_idx"
  ON "password_reset_tokens" USING btree ("staff_user_id");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_active_idx"
  ON "password_reset_tokens" USING btree ("staff_user_id", "expires_at");
