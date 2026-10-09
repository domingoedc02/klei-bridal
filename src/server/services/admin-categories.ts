import { and, asc, eq, ne, sql, type SQL } from "drizzle-orm";

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
} from "@/server/db/schema";
import type { DbOrTx } from "@/server/auth/session";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import { slugify } from "@/shared/slug";

/**
 * KBS-22-1: list / create / rename for the three editable vocabularies
 * (spec/api → Admin — categories). `type` only ever comes from the route
 * file's own literal, mapped here to a fixed table — never a path segment
 * turned into an identifier. Merge and the delete-in-use guard are KBS-22-2.
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

async function uniqueSlug(tx: DbOrTx, t: Table, name: string, fallback: string) {
  const base = (slugify(name) || fallback).slice(0, 80);
  const used = new Set(
    (
      await tx
        .select({ slug: t.slug })
        .from(t)
        .where(sql`${t.slug} like ${`${base}%`}`)
    ).map((r) => r.slug),
  );
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
  return db.transaction(async (tx) => {
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
        slug: await uniqueSlug(tx, t, input.name, entity),
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
  });
}

/**
 * Rename and tidy fields. The slug stays put: collections back public
 * landing URLs (KBS-10).
 * ponytail: no slug redirect table yet — add one with KBS-22-2's merge
 * ("keep slug as a redirect") if renames must also move the URL.
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
  return db.transaction(async (tx) => {
    const [old] = await tx.select().from(t).where(eq(t.id, id)).limit(1).for("update");
    if (!old) throw new PipelineError(404, "NOT_FOUND", "Value not found.");
    if (input.name !== undefined) {
      const existing = await exactMatch(tx, t, input.name, id);
      if (existing) conflict(existing);
    }
    const changes = Object.keys(input).filter((k) => input[k as keyof CategoryPatch] !== undefined);
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
  });
}
