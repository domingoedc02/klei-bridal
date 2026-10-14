import "server-only";

import type { CataloguePage } from "@/server/services/catalogue";
import {
  gownFilterQuerySchema,
  gownFilterQueryString,
  type GownFilterQuery,
} from "@/shared/schemas/gownFilters";

export const CATALOGUE_CACHE_KEY_MAX_BYTES = 512;

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
