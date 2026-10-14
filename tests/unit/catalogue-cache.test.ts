import { describe, expect, it } from "vitest";

import { catalogueCacheKey, parseCatalogueCacheQuery } from "../../src/server/services/catalogueCache";

describe("catalogue cache query contract", () => {
  it("gives equivalent normalized filters one key", () => {
    const first = parseCatalogueCacheQuery({ material: ["satin", "lace", "satin"], collection: "new-arrivals", page: "2" });
    const second = parseCatalogueCacheQuery({ material: ["lace", "satin"], collection: "new-arrivals", sort: "newest", page: "2" });
    expect(catalogueCacheKey(first)).toBe(catalogueCacheKey(second));
  });

  it("keeps every result-affecting field isolated", () => {
    const base = parseCatalogueCacheQuery({ q: "lace" });
    const variants = [{ q: "satin" }, { available: "1" }, { price_min: "100" }, { price_max: "100" }, { sort: "price_asc" }, { page: "2" }, { material: "lace" }];
    const keys = variants.map((variant) => catalogueCacheKey(parseCatalogueCacheQuery(variant)));
    expect(new Set([catalogueCacheKey(base), ...keys]).size).toBe(variants.length + 1);
  });

  it("rejects malformed input before key construction", () => {
    expect(() => parseCatalogueCacheQuery({ available: "true" })).toThrow();
    expect(() => parseCatalogueCacheQuery({ q: "x".repeat(81) })).toThrow();
    expect(() => parseCatalogueCacheQuery({ material: Array.from({ length: 21 }, (_, i) => `m-${i}`) })).toThrow();
    expect(() => parseCatalogueCacheQuery({ page: "0" })).toThrow();
    expect(() => parseCatalogueCacheQuery({ price_min: "2", price_max: "1" })).toThrow();
  });

  it("bypasses cache for valid keys over 512 UTF-8 bytes", () => {
    const query = parseCatalogueCacheQuery({ q: "é".repeat(80), material: Array.from({ length: 6 }, (_, i) => `material-${i}`) });
    expect(catalogueCacheKey(query)).toBeNull();
  });
});
