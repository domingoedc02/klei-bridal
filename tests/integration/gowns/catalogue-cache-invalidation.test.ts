import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
let actor: Principal;
const gownIds: string[] = [];
const imageIds: string[] = [];
const staffId = randomUUID();
import type { Principal } from "@/server/pipeline";
import { createCategory } from "@/server/services/admin-categories";
import { updateGownImageAlt } from "@/server/services/admin-gown-images";
import { createAdminGown, publishAdminGown } from "@/server/services/admin-gowns";
import { listCatalogue, type CataloguePage } from "@/server/services/catalogue";
import {
  afterCatalogueMutation,
  assertPublicCatalogueCacheValue,
  CatalogueCache,
  catalogueCache,
  catalogueCacheKey,
  parseCatalogueCacheQuery,
  resolveCatalogueCacheQuery,
  toPublicCatalogueCacheValue,
} from "@/server/services/catalogueCache";

function value(total = 1) {
  const page: CataloguePage = {
    canonicalized: false,
    cards: [],
    total,
    page: 1,
    pageCount: 1,
    vocabulary: { silhouettes: [], materials: [], collections: [] },
    query: parseCatalogueCacheQuery({}),
  };
  return toPublicCatalogueCacheValue(page);
}

beforeAll(async () => {
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Cache Test', ${`cache-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  actor = {
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
    staff: { id: staffId, name: "Cache Test", email: `cache-${staffId}@kleibridal.test` },
  };
});

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds}::uuid[])`;
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${staffId}`;
  for (const table of ["silhouettes", "materials", "collections"] as const) {
    await sql`DELETE FROM ${sql(table)} WHERE created_by = ${staffId}`;
  }
  await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
});

describe("catalogue cache Postgres read boundary", () => {
  it("loads published catalogue once, reuses cache, and bypasses injected DB", async () => {
    catalogueCache.clear();
    const query = parseCatalogueCacheQuery({});
    const before = catalogueCache.stats;
    const first = await listCatalogue(query);
    const afterFirst = catalogueCache.stats;
    const second = await listCatalogue(query);
    const afterSecond = catalogueCache.stats;

    expect(second).toEqual(first);
    expect(afterFirst.misses).toBe(before.misses + 1);
    expect(afterSecond.hits).toBe(afterFirst.hits + 1);

    // Distinct DB identity forces the injected test repository down direct SQL path.
    const injectedDb = Object.create(db) as typeof db;
    const beforeInjected = catalogueCache.stats;
    const injected = await listCatalogue(query, injectedDb);
    expect(injected).toEqual(first);
    expect(catalogueCache.stats).toEqual(beforeInjected);
  });

  it("keeps cached result inside public DTO boundary", async () => {
    catalogueCache.clear();
    const query = parseCatalogueCacheQuery({});
    const page = await listCatalogue(query);
    const resolved = resolveCatalogueCacheQuery(query, {
      silhouettes: page.vocabulary.silhouettes.map((option) => option.slug),
      materials: page.vocabulary.materials.map((option) => option.slug),
      collections: page.vocabulary.collections.map((option) => option.slug),
    });
    const key = catalogueCacheKey(resolved);
    expect(key).not.toBeNull();
    const cached = catalogueCache.read(key!);
    expect(cached).toBeDefined();
    expect(() => assertPublicCatalogueCacheValue(cached)).not.toThrow();
    expect(cached).not.toHaveProperty("headers");
    expect(cached).not.toHaveProperty("cookies");
    expect(cached).not.toHaveProperty("session");
  });
});

describe("catalogue cache mutation invalidation", () => {
  it("wires gown, image, and category owners to post-commit invalidation", async () => {
    const cache = catalogueCache;
    cache.clear();
    const before = cache.epoch;
    const gown = await createAdminGown(
      {
        name: `Cache gown ${randomUUID()}`,
        price_status: "on_request",
        price_minor: null,
        currency: "PHP",
        is_in_stock: true,
      },
      actor,
      db,
    );
    gownIds.push(gown.id);
    expect(cache.epoch).toBeGreaterThan(before);

    await sql`
      INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (${randomUUID()}, ${gown.id}, 0, true, ${`cache/${gown.id}.jpg`}, 10, 10)
    `;
    const imageEpoch = cache.epoch;
    const [image] = await sql`SELECT id FROM gown_images WHERE gown_id = ${gown.id}`;
    if (!image) throw new Error("test image missing");
    await updateGownImageAlt(gown.id, image.id as string, "updated", actor, null, db);
    expect(cache.epoch).toBeGreaterThan(imageEpoch);

    const categoryBefore = cache.epoch;
    const category = await createCategory(
      "collections",
      { name: `Cache category ${randomUUID()}`, confirm: true },
      actor,
      null,
      db,
    );
    expect(category.created).toBe(true);
    expect(cache.epoch).toBeGreaterThan(categoryBefore);
  });

  it("repeated publish no-op keeps cache epoch unchanged", async () => {
    const gown = await createAdminGown(
      {
        name: `Published cache gown ${randomUUID()}`,
        price_status: "on_request",
        price_minor: null,
        currency: "PHP",
        is_in_stock: true,
      },
      actor,
      db,
    );
    gownIds.push(gown.id);
    const image = randomUUID();
    imageIds.push(image);
    await sql`
      INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (${image}, ${gown.id}, 0, true, ${`cache/${image}.jpg`}, 10, 10)
    `;
    await publishAdminGown(gown.id, actor, db);
    const epoch = catalogueCache.epoch;
    await publishAdminGown(gown.id, actor, db);
    expect(catalogueCache.epoch).toBe(epoch);
  });
  it("invalidates only after committed mutation resolves", async () => {
    const cache = new CatalogueCache();
    const key = "catalogue:";
    const cached = value();
    cache.write(key, cached);
    let committed = false;

    const result = await (async () => {
      const mutation = Promise.resolve().then(() => {
        committed = true;
        return "committed";
      });
      const resolved = await mutation;
      cache.invalidateAfterCommit();
      return resolved;
    })();

    expect(result).toBe("committed");
    expect(committed).toBe(true);
    expect(cache.read(key)).toBeUndefined();
  });

  it("does not invalidate when mutation rejects", async () => {
    const cache = new CatalogueCache();
    const key = "catalogue:";
    cache.write(key, value());

    await expect(
      (async () => {
        await Promise.reject(new Error("rollback"));
        cache.invalidateAfterCommit();
      })(),
    ).rejects.toThrow("rollback");

    expect(cache.read(key)).toBeDefined();
  });

  it("reloads instead of inserting a pre-invalidation result", async () => {
    const cache = new CatalogueCache();
    const key = "catalogue:";
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const loading = cache.getOrLoad(key, async () => {
      loads += 1;
      if (loads === 1) await pending;
      return value(loads);
    });

    cache.invalidateAfterCommit();
    release();

    await expect(loading).resolves.toMatchObject({ total: 2 });
    expect(loads).toBe(2);
    expect(cache.read(key)).toMatchObject({ total: 2 });
  });

  it("committed wrapper preserves result and exposes disabled fallback", async () => {
    const cache = new CatalogueCache();
    cache.write("catalogue:", value());
    const before = cache.stats.epochDiscarded;

    cache.disableAfterInvalidationFailure();

    await expect(afterCatalogueMutation(Promise.resolve("saved"))).resolves.toBe("saved");
    expect(cache.isDisabled).toBe(true);
    expect(cache.stats.epochDiscarded).toBe(before);
    expect(cache.stats.invalidationFailures).toBeGreaterThanOrEqual(1);
  });
});
