import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { gownImages, gownSlugRedirects, gowns } from "@/server/db/schema";
import { PipelineError } from "@/server/pipeline/errors";

/**
 * The server-side re-check every write carrying browser-supplied gown ids
 * must call (KBS-11-3): each id must exist AND be published now. A draft,
 * archived or deleted gown is refused as 422 on the field, never trusted.
 */
export async function requirePublishedGowns(
  ids: readonly string[],
  field = "gown_ids",
  db: Database = defaultDb,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: gowns.id })
    .from(gowns)
    .where(and(inArray(gowns.id, [...ids]), eq(gowns.status, "published")));
  const unique = [...new Set(ids)];
  if (rows.length !== unique.length) {
    throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
      fields: { [field]: "One or more gowns are no longer available." },
    });
  }
  return unique;
}

export type GownImageForMetadata = {
  id: string;
  isHero: boolean;
  derivatives: unknown;
};

export type PublishedGown = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMinor?: number | null;
  currency?: string;
  priceStatus?: string;
  isInStock?: boolean;
  images: GownImageForMetadata[];
};

export type GownSlugResolution =
  | { kind: "canonical"; gown: PublishedGown }
  | { kind: "redirect"; gown: PublishedGown }
  | { kind: "missing" };

/**
 * Public slug lookup (KBS-15-1). Only a PUBLISHED gown resolves, by its own
 * slug or by a retired one in gown_slug_redirects. Everything else is
 * "missing", so a draft never reaches metadata and its image hashes stay private.
 */
export async function resolvePublishedGownSlug(
  slug: string,
  db: Database = defaultDb,
): Promise<GownSlugResolution> {
  const columns = {
    id: gowns.id,
    slug: gowns.slug,
    name: gowns.name,
    description: gowns.description,
  };
  const [own] = await db
    .select(columns)
    .from(gowns)
    .where(and(eq(gowns.slug, slug), eq(gowns.status, "published")))
    .limit(1);
  if (own) return { kind: "canonical", gown: await withImages(own, db) };
  const [moved] = await db
    .select(columns)
    .from(gownSlugRedirects)
    .innerJoin(gowns, eq(gowns.id, gownSlugRedirects.gownId))
    .where(and(eq(gownSlugRedirects.oldSlug, slug), eq(gowns.status, "published")))
    .limit(1);
  return moved ? { kind: "redirect", gown: await withImages(moved, db) } : { kind: "missing" };
}

async function withImages(gown: Omit<PublishedGown, "images">, db: Database) {
  const images = await db
    .select({ id: gownImages.id, isHero: gownImages.isHero, derivatives: gownImages.derivatives })
    .from(gownImages)
    .where(eq(gownImages.gownId, gown.id))
    .orderBy(asc(gownImages.sortOrder));
  return { ...gown, images };
}

/** og:description: the gown description, whitespace-collapsed, cut at 200 characters. */
export function metadataDescription(gown: Pick<PublishedGown, "description">): string | undefined {
  const text = gown.description?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= 200 ? text : `${text.slice(0, 199).trimEnd()}…`;
}
