import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
    expect(result.removed).toBe(1);
    await expect(
      import("node:fs/promises").then(({ access }) => access(join(originalsRoot(), shared))),
    ).resolves.toBeUndefined();
    await expect(
      import("node:fs/promises").then(({ access }) => access(join(originalsRoot(), orphan))),
    ).rejects.toThrow();
  });
});
