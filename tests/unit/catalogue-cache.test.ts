import { describe, expect, it } from "vitest";

import type { CataloguePage } from "../../src/server/services/catalogue";
import {
  assertPublicCatalogueCacheValue,
  CatalogueCache,
  catalogueCacheKey,
  isCatalogueCacheEligible,
  parseCatalogueCacheQuery,
  resolveCatalogueCacheQuery,
  toPublicCatalogueCacheValue,
} from "../../src/server/services/catalogueCache";

describe("catalogue cache query contract", () => {
  const pageFor = (id: number): CataloguePage => ({
    canonicalized: false,
    cards: [],
    total: id,
    page: 1,
    pageCount: 1,
    vocabulary: { silhouettes: [], materials: [], collections: [] },
    query: parseCatalogueCacheQuery({}),
  });
  const vocabulary = {
    silhouettes: ["a-line"],
    materials: ["lace", "satin"],
    collections: ["new-arrivals"],
  };

  const resolved = (input: Record<string, string | string[] | undefined>) =>
    resolveCatalogueCacheQuery(parseCatalogueCacheQuery(input), vocabulary);

  it("gives equivalent normalized filters one key", () => {
    const first = resolved({
      material: ["satin", "lace", "satin"],
      collection: "new-arrivals",
      page: "2",
    });
    const second = resolved({
      material: ["lace", "satin"],
      collection: "new-arrivals",
      sort: "newest",
      page: "2",
    });
    expect(catalogueCacheKey(first)).toBe(catalogueCacheKey(second));
  });

  it("drops unknown and inactive vocabulary values before key construction", () => {
    const omitted = resolved({});
    const invalid = resolved({ material: ["inactive", "unknown"], silhouette: "retired" });
    expect(catalogueCacheKey(invalid)).toBe(catalogueCacheKey(omitted));
  });

  it("canonicalizes q case because catalogue search uses ILIKE", () => {
    expect(catalogueCacheKey(resolved({ q: " Lace " }))).toBe(
      catalogueCacheKey(resolved({ q: "lace" })),
    );
  });

  it("rejects direct key construction from an unresolved or unvalidated query", () => {
    expect(() => catalogueCacheKey({} as never)).toThrow(TypeError);
    expect(() => catalogueCacheKey({ q: "x".repeat(81) } as never)).toThrow(TypeError);
  });

  it("keeps every result-affecting field isolated", () => {
    const base = resolved({ q: "lace" });
    const variants = [
      { q: "satin" },
      { available: "1" },
      { price_min: "100" },
      { price_max: "100" },
      { sort: "price_asc" },
      { page: "2" },
      { material: "lace" },
    ];
    const keys = variants.map((variant) => catalogueCacheKey(resolved(variant)));
    expect(new Set([catalogueCacheKey(base), ...keys]).size).toBe(variants.length + 1);
  });

  it("rejects malformed input before key construction", () => {
    expect(() => parseCatalogueCacheQuery({ available: "true" })).toThrow();
    expect(() => parseCatalogueCacheQuery({ q: "x".repeat(81) })).toThrow();
    expect(() =>
      parseCatalogueCacheQuery({ material: Array.from({ length: 21 }, (_, i) => `m-${i}`) }),
    ).toThrow();
    expect(() => parseCatalogueCacheQuery({ page: "0" })).toThrow();
    expect(() => parseCatalogueCacheQuery({ price_min: "2", price_max: "1" })).toThrow();
  });

  it("bypasses cache for valid keys over 512 UTF-8 bytes", () => {
    const longMaterials = Array.from({ length: 20 }, (_, i) => `material-${"x".repeat(20)}-${i}`);
    const query = resolveCatalogueCacheQuery(
      parseCatalogueCacheQuery({ q: "é".repeat(80), material: longMaterials }),
      { ...vocabulary, materials: longMaterials },
    );
    expect(catalogueCacheKey(query)).toBeNull();
  });

  it("allows only anonymous published public catalogue reads", () => {
    expect(
      isCatalogueCacheEligible({ anonymous: true, published: true, publicCatalogue: true }),
    ).toBe(true);
    expect(
      isCatalogueCacheEligible({ anonymous: false, published: true, publicCatalogue: true }),
    ).toBe(false);
    expect(
      isCatalogueCacheEligible({ anonymous: true, published: false, publicCatalogue: true }),
    ).toBe(false);
    expect(
      isCatalogueCacheEligible({ anonymous: true, published: true, publicCatalogue: false }),
    ).toBe(false);
  });

  it("isolates cache DTO boundary from raw catalogue page values", () => {
    const page = {
      canonicalized: false,
      cards: [],
      total: 0,
      page: 1,
      pageCount: 0,
      vocabulary: { silhouettes: [], materials: [], collections: [] },
      query: parseCatalogueCacheQuery({}),
    };
    expect(() => assertPublicCatalogueCacheValue(page)).toThrow(TypeError);
    const value = toPublicCatalogueCacheValue(page);
    expect(() => assertPublicCatalogueCacheValue(value)).not.toThrow();
  });

  it("bounds entries and evicts oldest first", async () => {
    const cache = new CatalogueCache();
    for (let i = 0; i < 513; i += 1) {
      await cache.getOrLoad(`key-${i}`, async () => toPublicCatalogueCacheValue(pageFor(i)));
    }
    expect(cache.size).toBe(512);
    expect(cache.read("key-0")).toBeUndefined();
    expect(cache.stats.evictions).toBe(1);
  });

  it("shares concurrent misses and removes in-flight promise after resolve", async () => {
    const cache = new CatalogueCache();
    let calls = 0;
    const value = toPublicCatalogueCacheValue(pageFor(1));
    const loader = async () => {
      calls += 1;
      await Promise.resolve();
      return value;
    };
    const results = await Promise.all([
      cache.getOrLoad("same", loader),
      cache.getOrLoad("same", loader),
    ]);
    expect(calls).toBe(1);
    expect(results[0]).toBe(results[1]);
  });

  it("expires entries after 60 seconds", async () => {
    const cache = new CatalogueCache();
    const value = toPublicCatalogueCacheValue(pageFor(1));
    await cache.getOrLoad("ttl", async () => value, 1_000);
    expect(cache.read("ttl", 60_999)).toBe(value);
    expect(cache.read("ttl", 61_001)).toBeUndefined();
  });

  it("discards result loaded before invalidation", async () => {
    const cache = new CatalogueCache();
    let resolve!: (value: typeof publicValue) => void;
    const publicValue = toPublicCatalogueCacheValue(pageFor(1));
    const pending = new Promise<typeof publicValue>((done) => {
      resolve = done;
    });
    const loading = cache.getOrLoad("epoch", () => pending);
    cache.invalidate();
    resolve(publicValue);
    expect(await loading).toBe(publicValue);
    expect(cache.read("epoch")).toBe(publicValue);
    expect(cache.stats.epochDiscarded).toBe(1);
  });

  it("bypasses reads and writes when disabled", async () => {
    const cache = new CatalogueCache();
    cache.invalidate({ disable: true });
    let calls = 0;
    const value = toPublicCatalogueCacheValue(pageFor(1));
    expect(
      await cache.getOrLoad("disabled", async () => {
        calls += 1;
        return value;
      }),
    ).toBe(value);
    expect(
      await cache.getOrLoad("disabled", async () => {
        calls += 1;
        return value;
      }),
    ).toBe(value);
    expect(calls).toBe(2);
    expect(cache.size).toBe(0);
  });
});
