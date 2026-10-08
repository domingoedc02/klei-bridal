import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";

/**
 * KBS-9 AC-8: an applied migration is never edited in place. Runs
 * scripts/migrate.ts (as `pnpm db:migrate` does) against a COPY of the
 * committed migrations, so the real files are never touched. Assumes the
 * database is already migrated (CI does this; see ci.yml) — the run is
 * then verify-only and writes nothing.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "drizzle", "migrations");

const sql = postgres(DATABASE_URL, { max: 1 });
const tempDirs: string[] = [];

function copyOfMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "kbs-migrations-"));
  tempDirs.push(dir);
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

function runMigrate(dir: string) {
  return spawnSync(
    "pnpm",
    ["exec", "tsx", "--conditions=react-server", "scripts/migrate.ts", "--dir", dir],
    {
      cwd: join(__dirname, "..", "..", ".."),
      env: { ...process.env, DATABASE_URL },
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("migrate: applied migrations are verified by sha256", () => {
  it("records the sha256 of every committed file it applied", async () => {
    const rows = await sql<{ filename: string; checksum: string | null }[]>`
      SELECT filename, checksum FROM _migrations ORDER BY filename
    `;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(rows.map((r) => r.filename)).toEqual(files);
    for (const row of rows) {
      const expected = createHash("sha256")
        .update(readFileSync(join(MIGRATIONS_DIR, row.filename)))
        .digest("hex");
      expect(row.checksum, row.filename).toBe(expected);
    }
  });

  it("passes when the applied files are unchanged", () => {
    const result = runMigrate(copyOfMigrations());
    expect(result.stderr).not.toMatch(/Migration failed/);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Already up to date/);
  }, 30_000);

  it("fails loudly when an applied file has been edited in place", () => {
    const dir = copyOfMigrations();
    appendFileSync(
      join(dir, "0001_vocabulary_and_gowns.sql"),
      "\n-- edited after it was applied\n",
    );

    const result = runMigrate(dir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Never edit an applied migration/);
    expect(result.stderr).toMatch(/0001_vocabulary_and_gowns\.sql: applied as sha256 [0-9a-f]{64}/);
  }, 30_000);
});
