import "server-only";

import type { CataloguePage } from "@/server/services/catalogue";
import {
  gownFilterQuerySchema,
  gownFilterQueryString,
  type GownFilterQuery,
} from "@/shared/schemas/gownFilters";

export const CATALOGUE_CACHE_KEY_MAX_BYTES = 512;
export type CatalogueCacheValue = CataloguePage;

export function normalizeCatalogueCacheQuery(input: GownFilterQuery): GownFilterQuery {
  return {
    ...input,
    silhouette: [...input.silhouette].sort(),
    material: [...input.material].sort(),
    collection: [...input.collection].sort(),
  };
}

export function parseCatalogueCacheQuery(
  input: Record<string, string | string[] | undefined>,
): GownFilterQuery {
  return gownFilterQuerySchema.parse(input);
}

export function catalogueCacheKey(input: GownFilterQuery): string | null {
  const normalized = normalizeCatalogueCacheQuery(input);
  const key = `catalogue:${gownFilterQueryString(normalized)}`;
  return Buffer.byteLength(key, "utf8") <= CATALOGUE_CACHE_KEY_MAX_BYTES ? key : null;
}
