import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * KBS-172: `pnpm db:seed` must succeed on a clean Postgres (settings.value is
 * NOT NULL) and be insert-only on a re-run. Uses a throwaway database so it
 * never races other suites that edit the shared `settings` rows (the
 * retention job test flips retention_enabled).
 */

const BASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const ROOT = join(__dirname, "..", "..", "..");
const scratch = `kbs172_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const scratchUrl = (() => {
  const u = new URL(BASE_URL);
  u.pathname = `/${scratch}`;
  return u.toString();
})();

const admin = postgres(BASE_URL, { max: 1 });
let db: ReturnType<typeof postgres>;

function run(script: string[]) {
  return spawnSync("pnpm", ["exec", "tsx", "--conditions=react-server", ...script], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: scratchUrl },
    encoding: "utf8",
  });
}

const settingsRows = () => db`SELECT key, value, updated_at FROM settings ORDER BY key`;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${scratch}`);
  db = postgres(scratchUrl, { max: 1 });
  const migrated = run(["scripts/migrate.ts"]);
  expect(migrated.status, migrated.stderr).toBe(0);
}, 90_000);

afterAll(async () => {
  await db?.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  await admin.end();
});

describe("db:seed on a clean database (KBS-172)", () => {
  it("exits 0 with every settings value non-null, retention off with a 24 placeholder", async () => {
    const seeded = run(["drizzle/seed/index.ts"]);
    expect(seeded.status, seeded.stderr).toBe(0);

    const rows = await settingsRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.value, row.key).not.toBeNull();
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.retention_months).toBe(24);
    expect(byKey.retention_enabled).toBe(false);
  }, 60_000);

  it("a re-seed adds nothing, changes nothing, and keeps an admin-edited retention_months", async () => {
    const before = await settingsRows();
    const gownsBefore = (await db`SELECT count(*)::int AS n FROM gowns`)[0]?.n;

    // The admin (KBS-25) edits the value; a re-seed must not reset it.
    await db`UPDATE settings SET value = ${db.json(36)} WHERE key = 'retention_months'`;
    const edited = await settingsRows();

    const reseeded = run(["drizzle/seed/index.ts"]);
    expect(reseeded.status, reseeded.stderr).toBe(0);

    const after = await settingsRows();
    expect(after).toEqual(edited);
    expect(after.map((r) => r.key)).toEqual(before.map((r) => r.key));
    expect(after.find((r) => r.key === "retention_months")?.value).toBe(36);
    const gownsAfter = (await db`SELECT count(*)::int AS n FROM gowns`)[0]?.n;
    expect(gownsAfter).toBe(gownsBefore);
  }, 60_000);
});
