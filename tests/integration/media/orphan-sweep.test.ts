import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { env } from "@/config/env";
import { db } from "@/server/db/client";
import { originalsRoot } from "@/server/media/contentAddress";
import { sweepOrphanedOriginals } from "@/server/media/orphanSweep";

const sql = postgres(env.DATABASE_URL, { max: 1 });
const staffId = randomUUID();
const gownIds: string[] = [];
const paths: string[] = [];

async function gown() {
  const id = randomUUID();
  await sql`INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${id}, ${`sweep-${id}`}, 'Sweep gown', 'draft', ${staffId}, ${staffId})`;
  gownIds.push(id);
  return id;
}

beforeAll(async () => {
  await sql`INSERT INTO staff_users (id, name, email, password_hash)
    VALUES (${staffId}, 'Sweep Staff', ${`sweep-${staffId}@kleibridal.test`}, 'not-used')`;
});

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds})`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  for (const path of paths) await rm(join(originalsRoot(), path), { force: true });
  await sql.end();
  await db.$client.end();
});

describe("original orphan sweep", () => {
  it("serializes a concurrent reference before unlink", async () => {
    const path = "ee/ff/" + "c".repeat(64) + ".jpg";
    paths.push(path);
    await mkdir(join(originalsRoot(), "ee/ff"), { recursive: true });
    await writeFile(join(originalsRoot(), path), "pending");
    const id = await gown();
    let sweepDone = false;
    let sweep!: Promise<void>;

    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${path}, 0))`;
      sweep = sweepOrphanedOriginals(db).then(() => {
        sweepDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sweepDone).toBe(false);
      await tx`INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
        VALUES (${randomUUID()}, ${id}, 0, true, ${path}, 1, 1)`;
    });
    await sweep;

    await expect(access(join(originalsRoot(), path))).resolves.toBeUndefined();
  });

  it("keeps a shared original and removes an unreferenced original", async () => {
    const shared = "aa/bb/" + "a".repeat(64) + ".jpg";
    const orphan = "cc/dd/" + "b".repeat(64) + ".jpg";
    paths.push(shared, orphan);
    await mkdir(join(originalsRoot(), "aa/bb"), { recursive: true });
    await mkdir(join(originalsRoot(), "cc/dd"), { recursive: true });
    await writeFile(join(originalsRoot(), shared), "shared");
    await writeFile(join(originalsRoot(), orphan), "orphan");
    const first = await gown();
    const second = await gown();
    await sql`INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (${randomUUID()}, ${first}, 0, true, ${shared}, 1, 1),
             (${randomUUID()}, ${second}, 0, true, ${shared}, 1, 1)`;
    await sql`DELETE FROM gowns WHERE id = ${first}`;

    const result = await sweepOrphanedOriginals(db);
    expect(result.scanned).toBeGreaterThanOrEqual(2);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    await expect(
      import("node:fs/promises").then(({ access }) => access(join(originalsRoot(), shared))),
    ).resolves.toBeUndefined();
    await expect(
      import("node:fs/promises").then(({ access }) => access(join(originalsRoot(), orphan))),
    ).rejects.toThrow();
  });
});
