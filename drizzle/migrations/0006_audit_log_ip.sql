-- KBS-62: spec/security's audit logging records the client IP. Nullable:
-- rows written before this column exist stay NULL (the data never
-- existed), and an image built before this migration still inserts
-- without it, so a rollback keeps working. `kbs_app` already holds
-- INSERT/SELECT on the whole table (0004), which covers the new column.
ALTER TABLE "audit_log" ADD COLUMN "ip" inet;
