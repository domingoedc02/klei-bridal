import { describe, expect, it } from "vitest";

import type { CataloguePage } from "@/server/services/catalogue";
import {
  afterCatalogueMutation,
  CatalogueCache,
  parseCatalogueCacheQuery,
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

describe("catalogue cache mutation invalidation", () => {
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
