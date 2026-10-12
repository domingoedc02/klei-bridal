-- KBS-24-1: admin-created and reset passwords force a change within 72 hours.
ALTER TABLE "staff_users"
  ADD COLUMN "temp_password_expires_at" timestamp with time zone;
