import type { MetadataRoute } from "next";

import { env } from "@/config/env";
import { listActiveVocabulary } from "@/server/services/catalogue";
import { gownFilterQuerySchema, gownFilterQueryString } from "@/shared/schemas/gownFilters";

// Reads live vocabulary from the DB, so never prerender at build time.
export const dynamic = "force-dynamic";

type Vocabulary = Awaited<ReturnType<typeof listActiveVocabulary>>;

/**
 * `/gowns` plus one canonical filter URL per ACTIVE collection/silhouette/material slug.
 * Renamed or merged (aliased) slugs are never listed: they 301 to their live successor
 * (KBS-88), so only the successor appears. Query strings use the same canonical
 * serializer as the page's `<link rel="canonical">`.
 */
export function buildSitemap(siteUrl: string, vocabulary: Vocabulary): MetadataRoute.Sitemap {
  const urls = ["/gowns"];
  for (const [key, rows] of [
    ["silhouette", vocabulary.silhouettes],
    ["material", vocabulary.materials],
    ["collection", vocabulary.collections],
  ] as const) {
    for (const { slug } of rows) {
      const query = gownFilterQueryString(gownFilterQuerySchema.parse({ [key]: slug }));
      urls.push(`/gowns?${query}`);
    }
  }
  return urls.map((path) => ({ url: `${siteUrl}${path}` }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(env.SITE_URL, await listActiveVocabulary());
}
