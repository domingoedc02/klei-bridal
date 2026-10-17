import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { collections, materials, silhouettes, taxonomySlugRedirects } from "@/server/db/schema";

const SLUG = /^[a-z0-9-]{1,80}$/;
const TYPES = ["collections", "silhouettes", "materials"] as const;
type TaxonomyType = (typeof TYPES)[number];

const QUERY_KEYS = new Set([
  "q",
  "silhouette",
  "material",
  "collection",
  "available",
  "price_min",
  "price_max",
  "sort",
  "page",
]);

function tableFor(type: TaxonomyType) {
  return type === "collections" ? collections : type === "silhouettes" ? silhouettes : materials;
}

function pathCandidate(pathname: string): { type: TaxonomyType; slug: string } | null {
  const match = /^\/(collections|silhouettes|materials)\/([^/]+)$/.exec(pathname);
  const slug = match?.[2];
  if (!match || !slug || !SLUG.test(slug)) return null;
  return { type: match[1] as TaxonomyType, slug };
}

export function isTaxonomyRedirectCandidate(url: URL): boolean {
  return (
    pathCandidate(url.pathname) !== null ||
    (url.pathname === "/gowns" &&
      ["silhouette", "material", "collection"].some((key) => url.searchParams.has(key)))
  );
}

async function directRedirect(type: TaxonomyType, slug: string, database: Database) {
  const table = tableFor(type);
  const [live] = await database
    .select({ slug: table.slug })
    .from(table)
    .where(and(eq(table.slug, slug), eq(table.isActive, true)))
    .limit(1);
  if (live) return null;

  const [alias] = await database
    .select({ targetId: taxonomySlugRedirects.targetId })
    .from(taxonomySlugRedirects)
    .where(and(eq(taxonomySlugRedirects.vocabulary, type), eq(taxonomySlugRedirects.oldSlug, slug)))
    .limit(1);
  if (!alias) return null;

  const [target] = await database
    .select({ slug: table.slug })
    .from(table)
    .where(and(eq(table.id, alias.targetId), eq(table.isActive, true)))
    .limit(1);
  return target ? `/${type}/${target.slug}` : null;
}

async function filterRedirect(url: URL, database: Database) {
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (QUERY_KEYS.has(key)) params.append(key, value);
  }

  let changed = false;
  for (const type of TYPES) {
    const key = type === "collections" ? "collection" : type.slice(0, -1);
    const values = [...new Set(params.getAll(key))].filter((value) => SLUG.test(value));
    if (!values.length) continue;
    const table = tableFor(type);
    const live = await database
      .select({ slug: table.slug })
      .from(table)
      .where(and(eq(table.isActive, true), inArray(table.slug, values)));
    const liveSlugs = new Set(live.map((row) => row.slug));
    const missing = values.filter((value) => !liveSlugs.has(value));
    if (!missing.length) continue;

    const aliases = await database
      .select({ oldSlug: taxonomySlugRedirects.oldSlug, targetId: taxonomySlugRedirects.targetId })
      .from(taxonomySlugRedirects)
      .where(
        and(
          eq(taxonomySlugRedirects.vocabulary, type),
          inArray(taxonomySlugRedirects.oldSlug, missing),
        ),
      );
    if (!aliases.length) continue;

    const replacements = new Map<string, string>();
    for (const alias of aliases) {
      const [target] = await database
        .select({ slug: table.slug })
        .from(table)
        .where(and(eq(table.id, alias.targetId), eq(table.isActive, true)))
        .limit(1);
      if (!target) return null;
      replacements.set(alias.oldSlug, target.slug);
    }
    const nextValues = values.map((value) => replacements.get(value) ?? value);
    if (nextValues.some((value, index) => value !== values[index])) {
      changed = true;
      params.delete(key);
      for (const value of nextValues) params.append(key, value);
    }
  }

  return changed ? `/gowns${params.toString() ? `?${params.toString()}` : ""}` : null;
}

/** Return only a same-origin relative redirect target; null means continue request. */
export async function taxonomyRedirectLocation(
  url: URL,
  database: Database = defaultDb,
): Promise<string | null> {
  if (url.pathname === "/gowns") return filterRedirect(url, database);
  const candidate = pathCandidate(url.pathname);
  return candidate ? directRedirect(candidate.type, candidate.slug, database) : null;
}

export const taxonomySlugPattern = SLUG;
