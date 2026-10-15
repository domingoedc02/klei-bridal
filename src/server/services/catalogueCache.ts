import "server-only";

import type { CataloguePage } from "@/server/services/catalogue";
import { readFileSync } from "node:fs";

import { logger } from "@/server/observability/logger";
import {
  gownFilterQuerySchema,
  gownFilterQueryString,
  type GownFilterQuery,
} from "@/shared/schemas/gownFilters";

export const CATALOGUE_CACHE_KEY_MAX_BYTES = 512;
export const CATALOGUE_CACHE_MAX_ENTRIES = 512;
export const CATALOGUE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const CATALOGUE_CACHE_TTL_MS = 60_000;

export type CatalogueVocabulary = {
  silhouettes: readonly string[];
  materials: readonly string[];
  collections: readonly string[];
};

/** Query after syntax validation and active-vocabulary resolution. */
export type ResolvedCatalogueCacheQuery = GownFilterQuery;

/** Explicit public DTO. Raw CataloguePage must not enter the cache directly. */
export type CatalogueCacheValue = {
  canonicalized: boolean;
  cards: CataloguePage["cards"];
  total: number;
  page: number;
  pageCount: number;
  vocabulary: CataloguePage["vocabulary"];
  query: ResolvedCatalogueCacheQuery;
};

const resolvedQueries = new WeakSet<object>();
const publicValues = new WeakSet<object>();

export function parseCatalogueCacheQuery(
  input: Record<string, string | string[] | undefined>,
): GownFilterQuery {
  return gownFilterQuerySchema.parse(input);
}

/**
 * Resolve active vocabulary before key construction. Unknown and inactive slugs
 * drop exactly as listCatalogue does, so they share omission's cache key.
 */
export function resolveCatalogueCacheQuery(
  input: GownFilterQuery,
  vocabulary: CatalogueVocabulary,
): ResolvedCatalogueCacheQuery {
  const resolve = (values: string[], active: readonly string[]) => {
    const allowed = new Set(active);
    return [...new Set(values.filter((value) => allowed.has(value)))].sort();
  };
  const resolved: ResolvedCatalogueCacheQuery = {
    ...input,
    q: input.q?.toLowerCase(),
    silhouette: resolve(input.silhouette, vocabulary.silhouettes),
    material: resolve(input.material, vocabulary.materials),
    collection: resolve(input.collection, vocabulary.collections),
  };
  resolvedQueries.add(resolved);
  return resolved;
}

export function catalogueCacheKey(input: ResolvedCatalogueCacheQuery): string | null {
  if (!resolvedQueries.has(input)) {
    throw new TypeError("catalogueCacheKey requires resolved catalogue query");
  }
  const key = `catalogue:${gownFilterQueryString(input)}`;
  return Buffer.byteLength(key, "utf8") <= CATALOGUE_CACHE_KEY_MAX_BYTES ? key : null;
}

export function isCatalogueCacheEligible(context: {
  anonymous: boolean;
  published: boolean;
  publicCatalogue: boolean;
}): boolean {
  return context.anonymous && context.published && context.publicCatalogue;
}

/** Copy only published, public catalogue fields into cache-safe DTO. */
export function toPublicCatalogueCacheValue(page: CataloguePage): CatalogueCacheValue {
  const value: CatalogueCacheValue = {
    canonicalized: page.canonicalized,
    cards: page.cards,
    total: page.total,
    page: page.page,
    pageCount: page.pageCount,
    vocabulary: page.vocabulary,
    query: page.query,
  };
  publicValues.add(value);
  return value;
}

export function assertPublicCatalogueCacheValue(
  value: unknown,
): asserts value is CatalogueCacheValue {
  if (typeof value !== "object" || value === null || !publicValues.has(value)) {
    throw new TypeError("catalogue cache accepts only public catalogue DTO");
  }
}

type CacheEntry = {
  value: CatalogueCacheValue;
  serializedBytes: number;
  expiresAt: number;
};

export type CatalogueCacheStats = {
  epochDiscarded: number;
  evictions: number;
  hits: number;
  misses: number;
  invalidationFailures: number;
  replicaPreflightFailures: number;
};

export type ReplicaPreflight = {
  count: number | null;
  source: "dokploy" | "unknown";
  /** True only when mandatory Dokploy preflight supplied this fact. */
  verified: boolean;
};

export type ReplicaPreflightEvidence = ReplicaPreflight & {
  enabled: boolean;
  reason: "exactly_one" | "unknown" | "not_exactly_one";
};

export function evaluateReplicaPreflight(fact: ReplicaPreflight): ReplicaPreflightEvidence {
  if (!fact.verified || fact.source !== "dokploy" || fact.count === null) {
    return { ...fact, count: null, enabled: false, reason: "unknown" };
  }
  if (fact.count !== 1) {
    return { ...fact, enabled: false, reason: "not_exactly_one" };
  }
  return { ...fact, enabled: true, reason: "exactly_one" };
}

/**
 * Process-local bounded cache. Loader failures are not swallowed: callers get
 * existing database errors, including normal request-ID/503 mapping upstream.
 */
export class CatalogueCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CatalogueCacheValue>>();
  private totalBytes = 0;
  private epochValue = 0;
  private disabled = false;
  private readonly statsState: CatalogueCacheStats = {
    epochDiscarded: 0,
    evictions: 0,
    hits: 0,
    misses: 0,
    invalidationFailures: 0,
    replicaPreflightFailures: 0,
  };

  get stats(): Readonly<CatalogueCacheStats> {
    return { ...this.statsState };
  }

  get epoch(): number {
    return this.epochValue;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  async getOrLoad(
    key: string | null,
    loader: () => Promise<CatalogueCacheValue>,
    now = Date.now(),
  ): Promise<CatalogueCacheValue> {
    if (key === null || this.disabled) return loader();

    try {
      const hit = this.read(key, now);
      if (hit) {
        this.statsState.hits += 1;
        return hit;
      }
      this.statsState.misses += 1;
    } catch {
      return loader();
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const loadEpoch = this.epoch;
    const promise = (async () => {
      const value = await loader();
      assertPublicCatalogueCacheValue(value);
      let currentValue = value;
      let currentEpoch = loadEpoch;
      while (currentEpoch !== this.epoch || this.disabled) {
        this.statsState.epochDiscarded += 1;
        if (this.disabled) return loader();
        currentEpoch = this.epoch;
        currentValue = await loader();
        assertPublicCatalogueCacheValue(currentValue);
        currentEpoch = this.epoch;
      }
      if (currentEpoch !== this.epoch || this.disabled) return loader();
      try {
        this.write(key, currentValue, now);
      } catch {
        // Cache storage is best effort. Return fresh DB value on cache failure.
      }
      return currentValue;
    })();
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  invalidate(options: { disable?: boolean } = {}): void {
    this.epochValue += 1;
    try {
      this.entries.clear();
      this.totalBytes = 0;
      if (options.disable) this.disabled = true;
    } catch {
      this.disabled = true;
      this.statsState.invalidationFailures += 1;
    }
  }

  invalidateAfterCommit(): void {
    this.invalidate();
  }

  disableAfterInvalidationFailure(): void {
    this.epochValue += 1;
    this.disabled = true;
    this.statsState.invalidationFailures += 1;
    try {
      this.entries.clear();
      this.totalBytes = 0;
    } catch {
      // Cache remains disabled; committed mutation must still resolve.
    }
  }

  enforceReplicaPreflight(evidence: ReplicaPreflightEvidence): void {
    if (evidence.enabled) return;
    this.epochValue += 1;
    this.disabled = true;
    this.statsState.replicaPreflightFailures += 1;
    try {
      this.entries.clear();
      this.totalBytes = 0;
    } catch {
      // Cache remains disabled even if clearing storage fails.
    }
  }

  clear(): void {
    this.epochValue += 1;
    try {
      this.entries.clear();
      this.totalBytes = 0;
      this.disabled = false;
    } catch {
      this.disabled = true;
    }
  }

  read(key: string, now = Date.now()): CatalogueCacheValue | undefined {
    if (this.disabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  write(key: string, value: CatalogueCacheValue, now = Date.now()): boolean {
    assertPublicCatalogueCacheValue(value);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return false;
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes >= CATALOGUE_CACHE_MAX_BYTES) return false;

    this.remove(key);
    while (
      this.entries.size >= CATALOGUE_CACHE_MAX_ENTRIES ||
      this.totalBytes + serializedBytes >= CATALOGUE_CACHE_MAX_BYTES
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return false;
      this.remove(oldest);
      this.statsState.evictions += 1;
    }
    this.entries.set(key, {
      value,
      serializedBytes,
      expiresAt: now + CATALOGUE_CACHE_TTL_MS,
    });
    this.totalBytes += serializedBytes;
    return true;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.serializedBytes;
  }
}

export const catalogueCache = new CatalogueCache();

/**
 * Startup receives verified preflight facts from the deploy/runtime boundary.
 * Environment variables are deliberately never accepted as replica evidence.
 */
let operatorInstalled = false;
const REPLICA_PREFLIGHT_FILE = "/run/kbs/replica-preflight.json";

export function readVerifiedReplicaPreflight(path = REPLICA_PREFLIGHT_FILE): ReplicaPreflight {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("count" in parsed) ||
      !("source" in parsed) ||
      !("verified" in parsed) ||
      parsed.source !== "dokploy" ||
      parsed.verified !== true ||
      (typeof parsed.count !== "number" && parsed.count !== null) ||
      (typeof parsed.count === "number" && (!Number.isInteger(parsed.count) || parsed.count < 0))
    ) {
      return { count: null, source: "unknown", verified: false };
    }
    return parsed as ReplicaPreflight;
  } catch {
    return { count: null, source: "unknown", verified: false };
  }
}

export function installCatalogueCacheOperator(
  fact: ReplicaPreflight = readVerifiedReplicaPreflight(),
): ReplicaPreflightEvidence {
  const evidence = evaluateReplicaPreflight(fact);
  if (!evidence.enabled) {
    catalogueCache.enforceReplicaPreflight(evidence);
    logger.error(
      {
        event: "catalogue_cache_replica_preflight_failed",
        count: evidence.count,
        reason: evidence.reason,
        enabled: false,
      },
      "catalogue_cache_disabled_replica_preflight",
    );
  }
  if (operatorInstalled || typeof process.on !== "function") return evidence;
  operatorInstalled = true;
  process.on("SIGUSR2", () => {
    logger.info(
      {
        event: "catalogue_cache_inspect",
        epoch: catalogueCache.epoch,
        entries: catalogueCache.size,
        bytes: catalogueCache.bytes,
        disabled: catalogueCache.isDisabled,
        stats: catalogueCache.stats,
      },
      "catalogue_cache_inspect",
    );
  });
  return evidence;
}

export function invalidateCatalogueCache(options: { disable?: boolean } = {}): void {
  catalogueCache.invalidate(options);
}

export function invalidateCatalogueCacheAfterCommit(): void {
  catalogueCache.invalidateAfterCommit();
}

export async function afterCatalogueMutation<T>(
  mutation: Promise<T>,
  shouldInvalidate: (result: T) => boolean = () => true,
): Promise<T> {
  const result = await mutation;
  if (shouldInvalidate(result)) {
    try {
      invalidateCatalogueCacheAfterCommit();
    } catch (error) {
      catalogueCache.disableAfterInvalidationFailure();
      logger.error(
        { event: "catalogue_cache_invalidation_failed", err: error },
        "catalogue_cache_invalidation_failed",
      );
    }
  }
  return result;
}

export async function getCatalogueCacheValue(
  key: string | null,
  loader: () => Promise<CatalogueCacheValue>,
): Promise<CatalogueCacheValue> {
  return catalogueCache.getOrLoad(key, loader);
}
