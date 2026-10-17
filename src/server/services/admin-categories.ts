import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { db as defaultDb, type Database } from "@/server/db/client";
import {
  auditLog,
  collections,
  gownCollections,
  gownMaterials,
  gowns,
  materials,
  silhouettes,
  taxonomySlugRedirects,
} from "@/server/db/schema";
import type { DbOrTx } from "@/server/auth/session";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import { slugify } from "@/shared/slug";
import { afterCatalogueMutation } from "@/server/services/catalogueCache";

/**
 * KBS-22-1: list / create / rename for the three editable vocabularies
 * (spec/api → Admin — categories). `type` only ever comes from the route
 * file's own literal, mapped here to a fixed table — never a path segment
 * turned into an identifier. KBS-22-2 adds delete (refused while in use)
 * and merge.
 */
export type CategoryType = "silhouettes" | "materials" | "collections";

// Usage subqueries name their columns by hand: drizzle renders a column
// unqualified inside select(), so `id` would bind to the inner table.
// The three tables share one column shape (silhouettes.ts), so one typed
// handle serves all of them; the runtime object still names its own table.
type Table = typeof silhouettes;
const TABLES: Record<CategoryType, { table: Table; entity: string; usage: () => SQL<number> }> = {
  silhouettes: {
    table: silhouettes,
    entity: "silhouette",
    usage: () =>
      sql<number>`(select count(*)::int from ${gowns} g where g.silhouette_id = ${silhouettes}.id)`,
  },
  materials: {
    table: materials as unknown as Table,
    entity: "material",
    usage: () =>
      sql<number>`(select count(*)::int from ${gownMaterials} gm where gm.material_id = ${materials}.id)`,
  },
  collections: {
    table: collections as unknown as Table,
    entity: "collection",
    usage: () =>
      sql<number>`(select count(*)::int from ${gownCollections} gc where gc.collection_id = ${collections}.id)`,
  },
};

/** Near-duplicate threshold from decision/category-vocabulary (pg_trgm). */
const NEAR_DUP = 0.6;

export type CategoryCreate = { name: string; description?: string | null; confirm: boolean };
export type CategoryPatch = {
  name?: string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
};

type Row = Table["$inferSelect"];

function present(row: Row, gownCount: number) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    sort_order: row.sortOrder,
    is_active: row.isActive,
    gown_count: gownCount,
  };
}

function config(type: CategoryType) {
  return TABLES[type];
}

/** Matches the DB's `lower(trim(name))` unique index, so 409 here == 23505 there. */
async function exactMatch(tx: DbOrTx, t: Table, name: string, exceptId?: string) {
  const same = sql`lower(trim(${t.name})) = lower(${name})`;
  const [row] = await tx
    .select({ id: t.id, name: t.name })
    .from(t)
    .where(exceptId ? and(same, ne(t.id, exceptId)) : same)
    .limit(1);
  return row;
}

async function uniqueSlug(
  tx: DbOrTx,
  t: Table,
  name: string,
  fallback: string,
  vocabulary: CategoryType,
) {
  const base = (slugify(name) || fallback).slice(0, 80);
  const used = new Set(
    (
      await tx
        .select({ slug: t.slug })
        .from(t)
        .where(sql`${t.slug} like ${`${base}%`}`)
    ).map((r) => r.slug),
  );
  const aliases = await tx
    .select({ slug: taxonomySlugRedirects.oldSlug })
    .from(taxonomySlugRedirects)
    .where(
      and(
        eq(taxonomySlugRedirects.vocabulary, vocabulary),
        sql`${taxonomySlugRedirects.oldSlug} like ${`${base}%`}`,
      ),
    );
  for (const alias of aliases) used.add(alias.slug);
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base.slice(0, 80 - `-${n}`.length)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new PipelineError(409, "CONFLICT", "Could not create a unique URL for this value.");
}

function conflict(existing: { name: string }): never {
  throw new PipelineError(409, "CONFLICT", `"${existing.name}" already exists.`);
}

export async function listCategories(type: CategoryType, db: Database = defaultDb) {
  const { table: t, usage } = config(type);
  const rows = await db
    .select({ row: t, gownCount: usage() })
    .from(t)
    .orderBy(asc(t.sortOrder), asc(t.name));
  return { items: rows.map((r) => present(r.row, Number(r.gownCount))) };
}

/**
 * The new row, or — when a similar name exists and the caller has not
 * confirmed — the closest match as `suggestion`, with nothing written
 * (a warning, not a block). An exact case/space-insensitive match is 409.
 */
export async function createCategory(
  type: CategoryType,
  input: CategoryCreate,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  const { table: t, entity } = config(type);
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const existing = await exactMatch(tx, t, input.name);
      if (existing) conflict(existing);
      if (!input.confirm) {
        const similar = await tx
          .select({ id: t.id, name: t.name, slug: t.slug })
          .from(t)
          .where(sql`similarity(lower(${t.name}), lower(${input.name})) > ${NEAR_DUP}`)
          .orderBy(sql`similarity(lower(${t.name}), lower(${input.name})) desc`)
          .limit(1);
        if (similar[0]) return { created: false as const, suggestion: similar[0] };
      }
      const now = new Date();
      const [row] = await tx
        .insert(t)
        .values({
          name: input.name,
          slug: await uniqueSlug(tx, t, input.name, entity, type),
          description: input.description ?? null,
          createdBy: actor.staff.id,
          updatedBy: actor.staff.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new PipelineError(500, "INTERNAL_ERROR", "Could not save this value.");
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: `${entity}.create`,
        entityType: entity,
        entityId: row.id,
        detail: {},
        ip: inetOrNull(ip),
      });
      return { created: true as const, item: present(row, 0) };
    }),
    (result) => result.created,
  );
}

/**
 * Rename and tidy fields. The slug stays put: collections back public
 * landing URLs (KBS-10).
 * ponytail: no slug redirect table — renames and merges drop the old URL.
 * Add `category_slug_redirects` (migration 0007) once a public page serves
 * vocab slugs that must survive a rename or merge.
 */
export async function updateCategory(
  type: CategoryType,
  id: string,
  input: CategoryPatch,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  const { table: t, entity, usage } = config(type);
  let changed = false;
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const [old] = await tx.select().from(t).where(eq(t.id, id)).limit(1).for("update");
      if (!old) throw new PipelineError(404, "NOT_FOUND", "Value not found.");
      if (input.name !== undefined) {
        const existing = await exactMatch(tx, t, input.name, id);
        if (existing) conflict(existing);
      }
      const changes = Object.keys(input).filter(
        (k) => input[k as keyof CategoryPatch] !== undefined,
      );
      changed = changes.length > 0;
      if (changes.length) {
        const now = new Date();
        await tx
          .update(t)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
            ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
            updatedBy: actor.staff.id,
            updatedAt: now,
          })
          .where(eq(t.id, id));
        await tx.insert(auditLog).values({
          occurredAt: now,
          actorUserId: actor.staff.id,
          action: `${entity}.update`,
          entityType: entity,
          entityId: id,
          detail: { fields: changes },
          ip: inetOrNull(ip),
        });
      }
      const [row] = await tx.select({ row: t, gownCount: usage() }).from(t).where(eq(t.id, id));
      return present(row!.row, Number(row!.gownCount));
    }),
    () => changed,
  );
}

/**
 * KBS-22-2: delete a value no gown uses. In use answers `{ inUse }` so the
 * handler can offer merge or deactivate; the FK's ON DELETE RESTRICT still
 * refuses a gown tagged between the count and the delete (23503 → 409).
 */
export async function deleteCategory(
  type: CategoryType,
  id: string,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
): Promise<{ deleted: true } | { inUse: number }> {
  const { table: t, entity, usage } = config(type);
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ name: t.name, slug: t.slug })
        .from(t)
        .where(eq(t.id, id))
        .for("update");
      if (!row) throw new PipelineError(404, "NOT_FOUND", "Value not found.");
      const [count] = await tx.select({ n: usage() }).from(t).where(eq(t.id, id));
      const inUse = Number(count!.n);
      if (inUse > 0) return { inUse };

      await tx.delete(t).where(eq(t.id, id));
      await tx.insert(auditLog).values({
        occurredAt: new Date(),
        actorUserId: actor.staff.id,
        action: `${entity}.delete`,
        entityType: entity,
        entityId: id,
        detail: { name: row.name, slug: row.slug },
        ip: inetOrNull(ip),
      });
      return { deleted: true as const };
    }),
    (result) => result.deleted === true,
  );
}

/** Re-points every gown from `source` to `target`; returns the gowns moved. */
async function repoint(tx: DbOrTx, type: CategoryType, source: string, target: string) {
  if (type === "silhouettes") {
    const moved = await tx
      .update(gowns)
      .set({ silhouetteId: target })
      .where(eq(gowns.silhouetteId, source))
      .returning({ id: gowns.id });
    return moved.length;
  }
  // A gown tagged with both keeps exactly one target row (composite PK).
  const link = type === "materials" ? gownMaterials : gownCollections;
  const col = type === "materials" ? gownMaterials.materialId : gownCollections.collectionId;
  await tx.execute(sql`
    insert into ${link} (gown_id, ${sql.raw(col.name)})
    select gown_id, ${target} from ${link} where ${col} = ${source}
    on conflict do nothing
  `);
  const moved = await tx.delete(link).where(eq(col, source)).returning({ id: link.gownId });
  return moved.length;
}

/**
 * KBS-22-2: merge `id` into `targetId` in one transaction — re-point gowns,
 * delete the source, one audit row. Both rows are locked in id order, so
 * two concurrent merges of the same pair serialise instead of deadlocking;
 * the loser then finds its source gone (404).
 */
export async function mergeCategory(
  type: CategoryType,
  id: string,
  targetId: string,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  if (id === targetId) {
    throw new PipelineError(422, "VALIDATION_ERROR", "A value cannot be merged into itself.", {
      fields: { target_id: "Choose a different value." },
    });
  }
  const { table: t, entity } = config(type);
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: t.id, name: t.name, slug: t.slug })
        .from(t)
        .where(inArray(t.id, [id, targetId]))
        .orderBy(asc(t.id))
        .for("update");
      const source = rows.find((r) => r.id === id);
      const target = rows.find((r) => r.id === targetId);
      if (!source || !target) throw new PipelineError(404, "NOT_FOUND", "Value not found.");

      const movedCount = await repoint(tx, type, id, targetId);
      await tx.insert(taxonomySlugRedirects).values({
        vocabulary: type,
        oldSlug: source.slug,
        targetId,
      });
      await tx.delete(t).where(eq(t.id, id));
      await tx.insert(auditLog).values({
        occurredAt: new Date(),
        actorUserId: actor.staff.id,
        action: `${entity}.merge`,
        entityType: entity,
        entityId: targetId,
        detail: {
          source_id: id,
          source_name: source.name,
          source_slug: source.slug,
          target_id: targetId,
          moved_count: movedCount,
        },
        ip: inetOrNull(ip),
      });
      return { moved_count: movedCount };
    }),
  );
}
