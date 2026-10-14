import { describe, expect, it } from "vitest";

import {
  assertPublicCatalogueCacheValue,
  catalogueCacheKey,
  isCatalogueCacheEligible,
  parseCatalogueCacheQuery,
  resolveCatalogueCacheQuery,
  toPublicCatalogueCacheValue,
} from "../../src/server/services/catalogueCache";

describe("catalogue cache query contract", () => {
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
});
