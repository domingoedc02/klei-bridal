import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";
import type { Principal } from "@/server/pipeline";
import { createCategory, mergeCategory } from "@/server/services/admin-categories";
import { taxonomyRedirectLocation } from "@/server/taxonomy-redirect";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const staffId = randomUUID();
const categoryIds: string[] = [];
let actor: Principal;

beforeAll(async () => {
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Taxonomy Alias Test', ${`taxonomy-alias-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  actor = {
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
    staff: {
      id: staffId,
      name: "Taxonomy Alias Test",
      email: `taxonomy-alias-${staffId}@kleibridal.test`,
    },
  };
});

afterAll(async () => {
  if (categoryIds.length) {
    await sql`DELETE FROM taxonomy_slug_redirects WHERE target_id = ANY(${categoryIds}::uuid[])`;
    await sql`DELETE FROM collections WHERE id = ANY(${categoryIds}::uuid[])`;
  }
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${staffId}`;
  await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
});

describe("taxonomy slug alias reservation", () => {
  it("reserves merged source slug and keeps old URL pointed at merge target", async () => {
    const suffix = randomUUID();
    const sourceName = `Reserved Historical ${suffix}`;
    const targetName = `Merge Target ${suffix}`;

    const source = await createCategory(
      "collections",
      { name: sourceName, confirm: true },
      actor,
      null,
      db,
    );
    const target = await createCategory(
      "collections",
      { name: targetName, confirm: true },
      actor,
      null,
      db,
    );
    if (!source.created || !target.created) throw new Error("category setup failed");
    categoryIds.push(source.item.id, target.item.id);

    await mergeCategory("collections", source.item.id, target.item.id, actor, null, db);

    const recreated = await createCategory(
      "collections",
      { name: sourceName, confirm: true },
      actor,
      null,
      db,
    );
    if (!recreated.created) throw new Error("category recreation failed");
    categoryIds.push(recreated.item.id);

    expect(recreated.item.slug).not.toBe(source.item.slug);
    await expect(
      taxonomyRedirectLocation(new URL(`http://localhost/collections/${source.item.slug}`), db),
    ).resolves.toBe(`/collections/${target.item.slug}`);
  });
});
