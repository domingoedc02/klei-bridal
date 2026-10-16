import { and, asc, count, eq, exists, ilike, inArray, like, or, sql } from "drizzle-orm";

import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { db as defaultDb, type Database } from "@/server/db/client";
import {
  auditLog,
  collections,
  gownCollections,
  gownMaterials,
  gownImages,
  gowns,
  imageJobs,
  materials,
  priceHistory,
  silhouettes,
} from "@/server/db/schema";
import type { DbOrTx } from "@/server/auth/session";
import { afterCatalogueMutation } from "@/server/services/catalogueCache";
import { slugify } from "@/shared/slug";

export type GownWrite = {
  name?: string;
  slug?: string;
  description?: string | null;
  silhouette_id?: string | null;
  material_ids?: string[];
  collection_ids?: string[];
  price_status?: "priced" | "on_request" | "unlisted";
  price_minor?: number | null;
  currency?: string;
  is_in_stock?: boolean;
  status?: "draft" | "archived";
};

type GownRow = typeof gowns.$inferSelect;

function validation(fields: Record<string, string>): never {
  throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", { fields });
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function validatePrice(
  input: Pick<GownWrite, "price_status" | "price_minor">,
  fields: Record<string, string>,
) {
  if (
    input.price_status === "priced" &&
    (!Number.isSafeInteger(input.price_minor) || (input.price_minor ?? 0) <= 0)
  ) {
    fields.price_minor = "Enter a positive price, or choose price on request.";
  }
  if (input.price_status !== "priced" && input.price_minor != null) {
    fields.price_minor = "A price is only allowed when price status is priced.";
  }
  if (Object.keys(fields).length) validation(fields);
}

async function validateRelations(tx: DbOrTx, input: GownWrite) {
  const materialIds = uniqueIds(input.material_ids ?? []);
  const collectionIds = uniqueIds(input.collection_ids ?? []);
  if (materialIds.length) {
    const rows = await tx
      .select({ id: materials.id })
      .from(materials)
      .where(inArray(materials.id, materialIds));
    if (rows.length !== materialIds.length)
      validation({ material_ids: "One or more materials are invalid." });
  }
  if (collectionIds.length) {
    const rows = await tx
      .select({ id: collections.id })
      .from(collections)
      .where(inArray(collections.id, collectionIds));
    if (rows.length !== collectionIds.length)
      validation({ collection_ids: "One or more collections are invalid." });
  }
  if (input.silhouette_id) {
    const [row] = await tx
      .select({ id: silhouettes.id })
      .from(silhouettes)
      .where(eq(silhouettes.id, input.silhouette_id))
      .limit(1);
    if (!row) validation({ silhouette_id: "Choose a valid silhouette." });
  }
  return { materialIds, collectionIds };
}

async function nextSlug(tx: DbOrTx, requested: string | undefined, name: string, current?: string) {
  const raw = requested?.trim() || slugify(name);
  const base = (slugify(raw) || "gown").slice(0, 80);
  if (current === base) return base;
  const rows = await tx
    .select({ slug: gowns.slug })
    .from(gowns)
    .where(like(gowns.slug, `${base}%`));
  const used = new Set(rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new PipelineError(409, "CONFLICT", "Could not create a unique gown URL.");
}

function changed(a: unknown, b: unknown): boolean {
  return a !== b;
}

async function relations(tx: DbOrTx, id: string) {
  const [materialRows, collectionRows] = await Promise.all([
    tx
      .select({ id: gownMaterials.materialId })
      .from(gownMaterials)
      .where(eq(gownMaterials.gownId, id)),
    tx
      .select({ id: gownCollections.collectionId })
      .from(gownCollections)
      .where(eq(gownCollections.gownId, id)),
  ]);
  return {
    material_ids: materialRows.map((row) => row.id),
    collection_ids: collectionRows.map((row) => row.id),
  };
}

export async function presentGown(tx: DbOrTx, row: GownRow) {
  const [tags, published] = await Promise.all([
    relations(tx, row.id),
    tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "gown.publish")))
      .limit(1),
  ]);
  return {
    id: row.id,
    slug: row.slug,
    slug_locked: published.length > 0,
    name: row.name,
    description: row.description,
    silhouette_id: row.silhouetteId,
    ...tags,
    price_minor: row.priceMinor,
    currency: row.currency,
    price_status: row.priceStatus,
    is_in_stock: row.isInStock,
    status: row.status,
  };
}

export async function listAdminGowns(
  input: { page: number; limit: number; search?: string; status?: string },
  db: Database = defaultDb,
) {
  const conditions = [];
  if (input.status) conditions.push(eq(gowns.status, input.status));
  if (input.search)
    conditions.push(
      or(ilike(gowns.name, `%${input.search}%`), ilike(gowns.slug, `%${input.search}%`))!,
    );
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(gowns)
      .where(where)
      .orderBy(asc(gowns.name))
      .limit(input.limit)
      .offset((input.page - 1) * input.limit),
    db.select({ count: count() }).from(gowns).where(where),
  ]);
  return {
    items: await Promise.all(rows.map((row) => presentGown(db, row))),
    page: input.page,
    limit: input.limit,
    total: total[0]?.count ?? 0,
  };
}

export async function getAdminGown(id: string, db: Database = defaultDb) {
  const [row] = await db.select().from(gowns).where(eq(gowns.id, id)).limit(1);
  if (!row) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
  return presentGown(db, row);
}

export async function createAdminGown(
  input: Required<
    Pick<GownWrite, "name" | "price_status" | "price_minor" | "currency" | "is_in_stock">
  > &
    GownWrite,
  actor: Principal,
  db: Database = defaultDb,
) {
  const fields: Record<string, string> = {};
  if (!input.name.trim()) fields.name = "Enter a gown name.";
  validatePrice(input, fields);
  if (input.currency !== "PHP") fields.currency = "Currency must be PHP.";
  if (Object.keys(fields).length) validation(fields);
  const now = new Date();
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const { materialIds, collectionIds } = await validateRelations(tx, input);
      const slug = await nextSlug(tx, input.slug, input.name);
      const [row] = await tx
        .insert(gowns)
        .values({
          slug,
          name: input.name.trim(),
          description: input.description ?? null,
          silhouetteId: input.silhouette_id ?? null,
          priceMinor: input.price_minor ?? null,
          currency: input.currency,
          priceStatus: input.price_status,
          isInStock: input.is_in_stock,
          status: "draft",
          createdBy: actor.staff.id,
          updatedBy: actor.staff.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new PipelineError(500, "INTERNAL_ERROR", "Could not save gown.");
      if (materialIds.length)
        await tx
          .insert(gownMaterials)
          .values(materialIds.map((materialId) => ({ gownId: row.id, materialId })));
      if (collectionIds.length)
        await tx
          .insert(gownCollections)
          .values(collectionIds.map((collectionId) => ({ gownId: row.id, collectionId })));
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "gown.create",
        entityType: "gown",
        entityId: row.id,
        detail: {},
      });
      return presentGown(tx, row);
    }),
  );
}

export async function updateAdminGown(
  id: string,
  input: GownWrite,
  actor: Principal,
  db: Database = defaultDb,
) {
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const [old] = await tx.select().from(gowns).where(eq(gowns.id, id)).limit(1);
      if (!old) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
      if (old.status !== "draft" && input.slug !== undefined && slugify(input.slug) !== old.slug)
        validation({ slug: "Published gown URLs cannot change." });
      if (old.status !== "draft" && input.slug !== undefined && slugify(input.slug) === old.slug) {
        // Accept the form's unchanged slug preview, but never regenerate it.
      }
      const merged: Pick<GownWrite, "price_status" | "price_minor"> = {
        price_status: (input.price_status ?? old.priceStatus) as GownWrite["price_status"],
        price_minor: input.price_status === undefined ? old.priceMinor : input.price_minor,
      };
      const fields: Record<string, string> = {};
      if (input.name !== undefined && !input.name.trim()) fields.name = "Enter a gown name.";
      validatePrice(merged, fields);
      if (input.currency !== undefined && input.currency !== "PHP")
        fields.currency = "Currency must be PHP.";
      if (Object.keys(fields).length) validation(fields);
      const tags = await validateRelations(tx, input);
      const slug =
        input.slug === undefined || old.status !== "draft"
          ? old.slug
          : await nextSlug(tx, input.slug, input.name ?? old.name, old.slug);
      const now = new Date();
      const [row] = await tx
        .update(gowns)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.silhouette_id !== undefined ? { silhouetteId: input.silhouette_id } : {}),
          ...(input.price_status !== undefined ? { priceStatus: input.price_status } : {}),
          ...(input.price_minor !== undefined || input.price_status !== undefined
            ? { priceMinor: input.price_minor ?? null }
            : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.is_in_stock !== undefined ? { isInStock: input.is_in_stock } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          slug,
          updatedBy: actor.staff.id,
          updatedAt: now,
        })
        .where(eq(gowns.id, id))
        .returning();
      if (!row) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
      if (input.material_ids !== undefined) {
        await tx.delete(gownMaterials).where(eq(gownMaterials.gownId, id));
        if (tags.materialIds.length)
          await tx
            .insert(gownMaterials)
            .values(tags.materialIds.map((materialId) => ({ gownId: id, materialId })));
      }
      if (input.collection_ids !== undefined) {
        await tx.delete(gownCollections).where(eq(gownCollections.gownId, id));
        if (tags.collectionIds.length)
          await tx
            .insert(gownCollections)
            .values(tags.collectionIds.map((collectionId) => ({ gownId: id, collectionId })));
      }
      if (changed(old.priceMinor, row.priceMinor) || changed(old.priceStatus, row.priceStatus)) {
        await tx.insert(priceHistory).values({
          gownId: id,
          oldPriceMinor: old.priceMinor,
          newPriceMinor: row.priceMinor,
          oldStatus: old.priceStatus,
          newStatus: row.priceStatus,
          actorUserId: actor.staff.id,
          changedAt: now,
        });
      }
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "gown.update",
        entityType: "gown",
        entityId: id,
        detail: {},
      });
      return presentGown(tx, row);
    }),
  );
}

export async function publishAdminGown(id: string, actor: Principal, db: Database = defaultDb) {
  let changed = false;
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gowns)
        .where(eq(gowns.id, id))
        .for("update");
      if (!row) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
      if (row.status === "published") return presentGown(tx, row);
      changed = true;
      if (row.status === "archived")
        throw new PipelineError(409, "CONFLICT", "Archived gowns cannot be published.");
      const [anyImage] = await tx
        .select({ id: gownImages.id })
        .from(gownImages)
        .where(eq(gownImages.gownId, id))
        .limit(1);
      if (!anyImage) validation({ images: "Add a gown image before publishing." });
      const readyHero = exists(
        tx
          .select({ one: sql`1` })
          .from(gownImages)
          .innerJoin(imageJobs, eq(imageJobs.gownImageId, gownImages.id))
          .where(
            and(
              eq(gownImages.gownId, id),
              eq(gownImages.isHero, true),
              eq(imageJobs.status, "done"),
            ),
          ),
      );
      const [ready] = await tx.select({ id: gowns.id }).from(gowns).where(readyHero);
      if (!ready) validation({ images: "Choose a hero photo that has finished processing." });
      if (row.priceStatus === "priced" && (!row.priceMinor || row.priceMinor <= 0)) {
        validation({ price_minor: "Enter a positive price, or choose price on request." });
      }
      const now = new Date();
      const [updated] = await tx
        .update(gowns)
        .set({ status: "published", updatedBy: actor.staff.id, updatedAt: now })
        .where(eq(gowns.id, id))
        .returning();
      if (!updated) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "gown.publish",
        entityType: "gown",
        entityId: id,
        detail: {},
      });
      return presentGown(tx, updated);
    }),
    () => changed,
  );
}

export async function deleteAdminGown(id: string, actor: Principal, db: Database = defaultDb) {
  return afterCatalogueMutation(
    db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: gowns.id, status: gowns.status })
        .from(gowns)
        .where(eq(gowns.id, id))
        .limit(1);
      if (!row) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
      if (row.status === "published")
        throw new PipelineError(409, "CONFLICT", "Published gowns cannot be deleted.");
      if (row.status === "archived")
        throw new PipelineError(
          409,
          "CONFLICT",
          "Archived gowns can only be restored or deleted by policy.",
        );

      const now = new Date();
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "gown.delete",
        entityType: "gown",
        entityId: id,
        detail: {},
      });
      await tx.delete(gowns).where(eq(gowns.id, id));
    }),
  );
}
