import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import {
  collections,
  gownCollections,
  gownImages,
  gownMaterials,
  gowns,
  materials,
  silhouettes,
} from "@/server/db/schema";
import type { GownFilterQuery } from "@/shared/schemas/gownFilters";
import {
  catalogueCacheKey,
  getCatalogueCacheValue,
  isCatalogueCacheEligible,
  resolveCatalogueCacheQuery,
  toPublicCatalogueCacheValue,
} from "@/server/services/catalogueCache";

export const CATALOGUE_PAGE_SIZE = 24;

type VocabularyOption = { name: string; slug: string };

type CatalogueImage = {
  altText: string | null;
  width: number;
  height: number;
  derivatives: unknown;
};

export type CatalogueCard = {
  id: string;
  slug: string;
  name: string;
  priceMinor: number | null;
  currency: string;
  priceStatus: string;
  isInStock: boolean;
  image: CatalogueImage | null;
};

export type CataloguePage = {
  canonicalized: boolean;
  cards: CatalogueCard[];
  total: number;
  page: number;
  pageCount: number;
  vocabulary: {
    silhouettes: VocabularyOption[];
    materials: VocabularyOption[];
    collections: VocabularyOption[];
  };
  query: GownFilterQuery;
};

function imageColumns() {
  return {
    id: gowns.id,
    slug: gowns.slug,
    name: gowns.name,
    priceMinor: gowns.priceMinor,
    currency: gowns.currency,
    priceStatus: gowns.priceStatus,
    isInStock: gowns.isInStock,
    imageAltText: gownImages.altText,
    imageWidth: gownImages.width,
    imageHeight: gownImages.height,
    imageDerivatives: gownImages.derivatives,
  };
}

async function loadCataloguePage(
  query: GownFilterQuery,
  vocabulary: {
    silhouettes: VocabularyOption[];
    materials: VocabularyOption[];
    collections: VocabularyOption[];
  },
  database: Database,
): Promise<CataloguePage> {
  const {
    silhouette: silhouetteSlugs,
    material: materialSlugs,
    collection: collectionSlugs,
  } = query;
  const conditions = [eq(gowns.status, "published")];
  if (query.q)
    conditions.push(
      or(ilike(gowns.name, `%${query.q}%`), ilike(gowns.description, `%${query.q}%`))!,
    );
  if (query.available === "1") conditions.push(eq(gowns.isInStock, true));
  if (query.price_min !== undefined)
    conditions.push(
      and(eq(gowns.priceStatus, "priced"), gte(gowns.priceMinor, query.price_min * 100))!,
    );
  if (query.price_max !== undefined)
    conditions.push(
      and(eq(gowns.priceStatus, "priced"), lte(gowns.priceMinor, query.price_max * 100))!,
    );
  if (silhouetteSlugs.length)
    conditions.push(
      exists(
        database
          .select({ id: silhouettes.id })
          .from(silhouettes)
          .where(
            and(eq(silhouettes.id, gowns.silhouetteId), inArray(silhouettes.slug, silhouetteSlugs)),
          ),
      ),
    );
  if (materialSlugs.length)
    conditions.push(
      exists(
        database
          .select({ id: gownMaterials.gownId })
          .from(gownMaterials)
          .innerJoin(materials, eq(materials.id, gownMaterials.materialId))
          .where(and(eq(gownMaterials.gownId, gowns.id), inArray(materials.slug, materialSlugs))),
      ),
    );
  if (collectionSlugs.length)
    conditions.push(
      exists(
        database
          .select({ id: gownCollections.gownId })
          .from(gownCollections)
          .innerJoin(collections, eq(collections.id, gownCollections.collectionId))
          .where(
            and(eq(gownCollections.gownId, gowns.id), inArray(collections.slug, collectionSlugs)),
          ),
      ),
    );

  const where = and(...conditions);
  const priceStatusOrder = sql<number>`case when ${gowns.priceStatus} = 'on_request' then 1 else 0 end`;
  const orderBy: SQL[] =
    query.sort === "price_asc"
      ? [asc(priceStatusOrder), asc(gowns.priceMinor), desc(gowns.createdAt)]
      : query.sort === "price_desc"
        ? [asc(priceStatusOrder), desc(gowns.priceMinor), desc(gowns.createdAt)]
        : [asc(priceStatusOrder), desc(gowns.createdAt)];
  const [rows, totalRows] = await Promise.all([
    database
      .select(imageColumns())
      .from(gowns)
      .leftJoin(gownImages, and(eq(gownImages.gownId, gowns.id), eq(gownImages.isHero, true)))
      .where(where)
      .orderBy(...orderBy)
      .limit(CATALOGUE_PAGE_SIZE)
      .offset((query.page - 1) * CATALOGUE_PAGE_SIZE),
    database
      .select({ total: count(gowns.id) })
      .from(gowns)
      .where(where),
  ]);
  const total = Number(totalRows[0]?.total ?? 0);
  return {
    canonicalized: false,
    cards: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      priceMinor: row.priceMinor,
      currency: row.currency,
      priceStatus: row.priceStatus,
      isInStock: row.isInStock,
      image:
        row.imageDerivatives === null
          ? null
          : {
              altText: row.imageAltText,
              width: row.imageWidth!,
              height: row.imageHeight!,
              derivatives: row.imageDerivatives,
            },
    })),
    total,
    page: query.page,
    pageCount: Math.ceil(total / CATALOGUE_PAGE_SIZE),
    vocabulary,
    query,
  };
}

export async function listCatalogue(
  input: GownFilterQuery,
  database: Database = defaultDb,
): Promise<CataloguePage> {
  const [silhouetteRows, materialRows, collectionRows] = await Promise.all([
    database
      .select({ name: silhouettes.name, slug: silhouettes.slug })
      .from(silhouettes)
      .where(eq(silhouettes.isActive, true))
      .orderBy(asc(silhouettes.sortOrder), asc(silhouettes.name)),
    database
      .select({ name: materials.name, slug: materials.slug })
      .from(materials)
      .where(eq(materials.isActive, true))
      .orderBy(asc(materials.sortOrder), asc(materials.name)),
    database
      .select({ name: collections.name, slug: collections.slug })
      .from(collections)
      .where(eq(collections.isActive, true))
      .orderBy(asc(collections.sortOrder), asc(collections.name)),
  ]);
  const vocabulary = {
    silhouettes: silhouetteRows,
    materials: materialRows,
    collections: collectionRows,
  };
  const query = resolveCatalogueCacheQuery(input, {
    silhouettes: silhouetteRows.map((value) => value.slug),
    materials: materialRows.map((value) => value.slug),
    collections: collectionRows.map((value) => value.slug),
  });
  const canonicalized =
    query.silhouette.length !== input.silhouette.length ||
    query.material.length !== input.material.length ||
    query.collection.length !== input.collection.length;
  const cacheEnabled =
    database === defaultDb &&
    isCatalogueCacheEligible({ anonymous: true, published: true, publicCatalogue: true });
  const key = cacheEnabled ? catalogueCacheKey(query) : null;
  const cached = await getCatalogueCacheValue(key, async () =>
    toPublicCatalogueCacheValue(await loadCataloguePage(query, vocabulary, database)),
  );
  return { ...cached, canonicalized, query };
}
