import { describe, expect, it, vi } from "vitest";

import { logger } from "@/server/observability/logger";

import type { CataloguePage } from "../../src/server/services/catalogue";
import type { CatalogueCacheValue } from "../../src/server/services/catalogueCache";
import {
  assertPublicCatalogueCacheValue,
  evaluateReplicaPreflight,
  installCatalogueCacheOperator,
  afterCatalogueMutation,
  CATALOGUE_CACHE_MAX_BYTES,
  CatalogueCache,
  catalogueCache,
  catalogueCacheKey,
  isCatalogueCacheEligible,
  parseCatalogueCacheQuery,
  resolveCatalogueCacheQuery,
  toPublicCatalogueCacheValue,
} from "../../src/server/services/catalogueCache";

describe("catalogue cache replica preflight", () => {
  it("ignores spoofable environment replica counts at startup", () => {
    const previous = process.env.KBS_REPLICA_COUNT;
    process.env.KBS_REPLICA_COUNT = "1";
    try {
      expect(installCatalogueCacheOperator()).toMatchObject({
        count: null,
        enabled: false,
        reason: "unknown",
        verified: false,
      });
    } finally {
      if (previous === undefined) delete process.env.KBS_REPLICA_COUNT;
      else process.env.KBS_REPLICA_COUNT = previous;
    }
  });

  it("enables startup only for verified exactly-one fact", () => {
    expect(
      installCatalogueCacheOperator({ count: 1, source: "dokploy", verified: true }),
    ).toMatchObject({ count: 1, enabled: true, reason: "exactly_one", verified: true });
  });

  it.each([
    [{ count: 1, source: "dokploy" as const, verified: true }, true, "exactly_one"],
    [{ count: 0, source: "dokploy" as const, verified: true }, false, "not_exactly_one"],
    [{ count: 2, source: "dokploy" as const, verified: true }, false, "not_exactly_one"],
    [{ count: null, source: "unknown" as const, verified: false }, false, "unknown"],
    [{ count: null, source: "dokploy" as const, verified: false }, false, "unknown"],
    [{ count: 1, source: "dokploy" as const, verified: false }, false, "unknown"],
  ])("returns bounded evidence for %j", (fact, enabled, reason) => {
    expect(evaluateReplicaPreflight(fact)).toMatchObject({
      count: fact.verified ? fact.count : null,
      enabled,
      reason,
    });
  });

  it.each([
    { count: 0, source: "dokploy" as const, verified: true },
    { count: 2, source: "dokploy" as const, verified: true },
    { count: null, source: "unknown" as const, verified: false },
    { count: 1, source: "dokploy" as const, verified: false },
  ])("fails closed for %j", (fact) => {
    const cache = new CatalogueCache();
    const page: CataloguePage = {
      canonicalized: false,
      cards: [],
      total: 1,
      page: 1,
      pageCount: 1,
      vocabulary: { silhouettes: [], materials: [], collections: [] },
      query: parseCatalogueCacheQuery({}),
    };
    cache.write("catalogue:", toPublicCatalogueCacheValue(page));
    cache.enforceReplicaPreflight(evaluateReplicaPreflight(fact));
    expect(cache.isDisabled).toBe(true);
    expect(cache.read("catalogue:")).toBeUndefined();
    expect(cache.stats.replicaPreflightFailures).toBe(1);
  });
});

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

  it("falls back when serialization fails", async () => {
    const cache = new CatalogueCache();
    const value = toPublicCatalogueCacheValue(pageFor(1));
    const circular = value as CatalogueCacheValue & { circular?: unknown };
    circular.circular = circular;
    let calls = 0;
    expect(
      await cache.getOrLoad("serialization", async () => {
        calls += 1;
        return circular;
      }),
    ).toBe(circular);
    expect(calls).toBe(1);
    expect(cache.size).toBe(0);
    delete circular.circular;
  });

  it("falls back when cache read or write fails", async () => {
    const cache = new CatalogueCache();
    const value = toPublicCatalogueCacheValue(pageFor(1));
    const read = cache.read.bind(cache);
    cache.read = () => {
      throw new Error("read failed");
    };
    expect(await cache.getOrLoad("read-failure", async () => value)).toBe(value);
    cache.read = read;
    cache.write = () => {
      throw new Error("write failed");
    };
    expect(await cache.getOrLoad("write-failure", async () => value)).toBe(value);
  });

  it("cleans rejected loader and propagates dual failure", async () => {
    const cache = new CatalogueCache();
    const failure = new Error("database unavailable");
    await expect(cache.getOrLoad("rejected", async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    await expect(cache.getOrLoad("rejected", async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
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

  it("counts UTF-8 bytes strictly below the 64 MiB ceiling", () => {
    const cache = new CatalogueCache();
    const value = toPublicCatalogueCacheValue(pageFor(1));
    const payload = value as CatalogueCacheValue & { payload?: string };
    payload.payload = "é".repeat(Math.ceil(CATALOGUE_CACHE_MAX_BYTES / 2));

    expect(cache.write("too-large", payload)).toBe(false);
    expect(cache.size).toBe(0);
    delete payload.payload;
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

  it("rechecks epoch after recovery load", async () => {
    const cache = new CatalogueCache();
    const initial = toPublicCatalogueCacheValue(pageFor(1));
    const recovered = toPublicCatalogueCacheValue(pageFor(2));
    let calls = 0;
    let resolveRecovery!: (value: typeof recovered) => void;
    const recovery = new Promise<typeof recovered>((done) => {
      resolveRecovery = done;
    });
    const loading = cache.getOrLoad("recovery", async () => {
      calls += 1;
      if (calls === 1) return initial;
      if (calls === 2) return recovery;
      return recovered;
    });
    cache.invalidate();
    resolveRecovery(recovered);
    expect(await loading).toBe(recovered);
    expect(cache.read("recovery")).toBe(recovered);
    expect(cache.stats.epochDiscarded).toBe(1);
  });

  it("advances epoch and disables cache when invalidation fails", async () => {
    const cache = catalogueCache;
    cache.clear();
    const value = toPublicCatalogueCacheValue(pageFor(1));
    cache.write("failure", value);
    const before = cache.epoch;
    const invalidate = vi.spyOn(cache, "invalidateAfterCommit").mockImplementation(() => {
      throw new Error("cache clear failed; token=secret");
    });
    const disable = vi.spyOn(cache, "disableAfterInvalidationFailure");
    const log = vi.spyOn(logger, "error").mockImplementation(() => logger);

    await expect(afterCatalogueMutation(Promise.resolve("saved"))).resolves.toBe("saved");
    expect(cache.epoch).toBeGreaterThan(before);
    expect(cache.isDisabled).toBe(true);
    expect(cache.read("failure")).toBeUndefined();
    expect(cache.stats.invalidationFailures).toBeGreaterThanOrEqual(1);
    expect(disable).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      { event: "catalogue_cache_invalidation_failed", err: expect.any(Error) },
      "catalogue_cache_invalidation_failed",
    );

    invalidate.mockRestore();
    disable.mockRestore();
    log.mockRestore();
  });

  it("bypasses reads and writes when disabled", async () => {
    const cache = new CatalogueCache();
    const value = toPublicCatalogueCacheValue(pageFor(1));
    expect(cache.write("disabled", value)).toBe(true);
    cache.invalidate({ disable: true });
    expect(cache.read("disabled")).toBeUndefined();
    let calls = 0;
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
