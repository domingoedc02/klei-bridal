import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { requirePublishedGowns } from "@/server/services/gowns";

// KBS-11-3: browser-supplied gown ids are re-checked against Postgres.

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const ids: string[] = [];

async function gown(status: "draft" | "published" | "archived"): Promise<string> {
  const id = randomUUID();
  ids.push(id);
  await sql`INSERT INTO gowns (id, slug, name, status) VALUES (${id}, ${`kbs113-${id}`}, 'Test', ${status})`;
  return id;
}

afterAll(async () => {
  await sql`DELETE FROM gowns WHERE id = ANY(${ids}::uuid[])`;
  await sql.end();
});

describe("requirePublishedGowns", () => {
  it("returns published ids, deduped", async () => {
    const a = await gown("published");
    expect(await requirePublishedGowns([a, a])).toEqual([a]);
  });

  it("refuses draft, archived and unknown ids with a 422 on the field", async () => {
    const live = await gown("published");
    for (const bad of [await gown("draft"), await gown("archived"), randomUUID()]) {
      await expect(requirePublishedGowns([live, bad], "favourites")).rejects.toMatchObject({
        status: 422,
        code: "VALIDATION_ERROR",
        fields: { favourites: "One or more gowns are no longer available." },
      });
    }
  });
});
