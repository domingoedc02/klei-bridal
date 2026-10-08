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
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

import { env } from "../src/config/env";

const MIGRATIONS_DIR = join(__dirname, "..", "drizzle", "migrations");
const BREAKPOINT = "--> statement-breakpoint";

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

    const appliedRows = await sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
    const applied = new Set(appliedRows.map((r) => r.filename));

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
        await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
      });

      appliedCount += 1;
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

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
