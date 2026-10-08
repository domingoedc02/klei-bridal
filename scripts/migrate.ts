/**
 * Applies committed SQL migrations from drizzle/migrations/, in filename
 * order, each inside its own transaction, tracked in a `_migrations`
 * table so a re-run only applies what is new. This is the one way
 * migrations are ever applied — `drizzle-kit push` is never used
 * against a database that matters (spec/conventions, spec/data-model).
 *
 * Files use the same `--> statement-breakpoint` marker `drizzle-kit
 * generate` emits, so a single statement containing semicolons (a `DO
 * $$ ... $$` block) is never mis-split.
 *
 * Applied files are never edited in place (KBS-9 AC-8): every row
 * records the sha256 of the file's bytes, and a run whose files no
 * longer match refuses to apply anything. Rows applied before 0005 added
 * the column are backfilled from the files as they stand, once.
 *
 * `--dir <path>` points at another migrations directory — for the
 * integration test only, which runs this against an edited copy.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";

import { env } from "../src/config/env";

const { values: args } = parseArgs({ options: { dir: { type: "string" } } });
const MIGRATIONS_DIR = args.dir
  ? resolve(args.dir)
  : join(__dirname, "..", "drizzle", "migrations");
const BREAKPOINT = "--> statement-breakpoint";

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1 });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const checksums = new Map(
      files.map((f) => [f, sha256(readFileSync(join(MIGRATIONS_DIR, f)))] as const),
    );

    // Verify every applied file BEFORE applying anything new, so an edited
    // file stops the run with nothing half-done.
    let hasChecksum = await checksumColumnExists(sql);
    const appliedRows = await sql<{ filename: string; checksum: string | null }[]>`
      SELECT filename, ${hasChecksum ? sql`checksum` : sql`NULL::text`} AS checksum FROM _migrations
    `;
    const applied = new Set(appliedRows.map((r) => r.filename));

    const mismatches = appliedRows.flatMap((row) => {
      const current = checksums.get(row.filename);
      if (current === undefined) {
        return [`${row.filename}: applied, but the file is missing from ${MIGRATIONS_DIR}`];
      }
      if (row.checksum !== null && row.checksum !== current) {
        return [`${row.filename}: applied as sha256 ${row.checksum}, file is now ${current}`];
      }
      return [];
    });
    if (mismatches.length > 0) {
      throw new Error(
        "Applied migration(s) changed since they ran. Never edit an applied migration — " +
          "write a new one instead.\n  " +
          mismatches.join("\n  "),
      );
    }

    let appliedCount = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip   ${file} (already applied)`);
        continue;
      }

      const contents = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const statements = contents
        .split(BREAKPOINT)
        .map((s) => s.trim())
        .filter(Boolean);

      console.log(`apply  ${file} (${statements.length} statement(s))`);

      await sql.begin(async (tx) => {
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
        // The file itself may have just added the column (0005).
        if (hasChecksum || (await checksumColumnExists(tx))) {
          await tx`
            INSERT INTO _migrations (filename, checksum) VALUES (${file}, ${checksums.get(file) ?? null})
          `;
        } else {
          await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
        }
      });

      appliedCount += 1;
      hasChecksum ||= await checksumColumnExists(sql);
    }

    // Backfill rows applied before the column existed. Verified above that
    // none of them is missing, so this records the committed bytes.
    if (hasChecksum) {
      const unrecorded = await sql<{ filename: string }[]>`
        SELECT filename FROM _migrations WHERE checksum IS NULL ORDER BY filename
      `;
      for (const { filename } of unrecorded) {
        await sql`
          UPDATE _migrations SET checksum = ${checksums.get(filename) ?? null}
          WHERE filename = ${filename} AND checksum IS NULL
        `;
        console.log(`record ${filename} (checksum backfilled)`);
      }
    }

    console.log(
      appliedCount === 0
        ? "Already up to date — nothing to apply."
        : `Applied ${appliedCount} migration(s). Up to date.`,
    );
  } finally {
    await sql.end();
  }
}

async function checksumColumnExists(sql: postgres.Sql | postgres.TransactionSql): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = '_migrations' AND column_name = 'checksum'
  `;
  return rows.length > 0;
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
