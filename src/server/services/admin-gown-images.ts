import "server-only";
import { and, asc, count, eq, max, sql } from "drizzle-orm";

import { env } from "@/config/env";
import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, gownImages, gowns, imageJobs } from "@/server/db/schema";
import { originalPath, storeOriginal } from "@/server/media/contentAddress";
import { lockOriginalPath } from "@/server/media/originalLock";
import { sanitizeImage } from "@/server/media/upload";
import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { inetOrNull } from "@/server/ratelimit/client-ip";

export interface GownImage {
  id: string;
  sort_order: number;
  is_hero: boolean;
  alt_text: string | null;
  width: number;
  height: number;
  /** Encode state from the image's job (KBS-21-2); a fresh upload is always pending. */
  status: ImageStatus;
}

export type ImageStatus = "pending" | "ready" | "failed";

function tooMany(existing: number): never {
  throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
    fields: {
      files: `A gown can have at most ${env.IMAGE_MAX_PER_GOWN} photos; it already has ${existing}.`,
    },
  });
}

/** errnos meaning the media volume itself is unwritable or full (KBS-21 failure branch). */
const VOLUME_ERRNOS = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT"]);

/**
 * A full or read-only volume is an operational fault, not a bug: a clear 503
 * the staff member can act on, rolled back so no row claims success, and
 * reported (the mapper reports every 5xx) because a full disk takes Postgres
 * down with it (spec/operations).
 */
function volumeError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (!code || !VOLUME_ERRNOS.has(code)) throw error;
  throw new PipelineError(
    503,
    "SERVICE_UNAVAILABLE",
    "Photo storage is full or unavailable, so nothing was saved. Please tell the site administrator.",
    { detail: `media volume ${code}`, cause: error },
  );
}

async function imageCount(db: Database, gownId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(gownImages)
    .where(eq(gownImages.gownId, gownId));
  return row?.n ?? 0;
}

/**
 * POST /admin/gowns/:id/images (KBS-13-1). Validates and stores every file
 * BEFORE the transaction (CPU and disk stay out of the row lock), then, in
 * one transaction: gown_images rows, one pending image_jobs row each, one
 * audit row. Nothing is encoded beyond the sanitised master.
 *
 * ponytail: a transaction that fails after storeOriginal leaves an
 * unreferenced original; the orphan sweep (decision/images §3) reclaims it.
 */
export async function addGownImages(
  gownId: string,
  files: File[],
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
): Promise<{ images: GownImage[] }> {
  if (files.length === 0) {
    throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
      fields: { files: "Choose at least one photo to upload." },
    });
  }
  // Cheap pre-checks so a missing gown or a full gallery costs no decode.
  const [gown] = await db.select({ id: gowns.id }).from(gowns).where(eq(gowns.id, gownId));
  if (!gown) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
  const before = await imageCount(db, gownId);
  if (before + files.length > env.IMAGE_MAX_PER_GOWN) tooMany(before);

  // Sequential on purpose: ten parallel 40 MP decodes is the memory spike
  // the pixel cap exists to prevent.
  const stored: { data: Buffer; ext: string; path: string; width: number; height: number }[] = [];
  for (const file of files) {
    const clean = await sanitizeImage(Buffer.from(await file.arrayBuffer()));
    const ext = clean.format === "jpeg" ? "jpg" : clean.format;
    stored.push({
      data: clean.data,
      ext,
      path: originalPath(clean.data, ext),
      width: clean.width,
      height: clean.height,
    });
  }

  return db.transaction(async (tx) => {
    for (const image of stored) {
      await lockOriginalPath(tx, image.path);
      await storeOriginal(image.data, image.ext).catch(volumeError);
    }
    // The gown row lock serialises concurrent uploads to one gown, so the
    // count, the next sort_order and the hero choice cannot race.
    const [locked] = await tx
      .select({ id: gowns.id })
      .from(gowns)
      .where(eq(gowns.id, gownId))
      .for("update");
    if (!locked) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
    const [state] = await tx
      .select({ n: count(), last: max(gownImages.sortOrder) })
      .from(gownImages)
      .where(eq(gownImages.gownId, gownId));
    const existing = state?.n ?? 0;
    if (existing + stored.length > env.IMAGE_MAX_PER_GOWN) tooMany(existing);
    const [hero] = await tx
      .select({ id: gownImages.id })
      .from(gownImages)
      .where(and(eq(gownImages.gownId, gownId), eq(gownImages.isHero, true)));

    const start = (state?.last ?? -1) + 1;
    const rows = await tx
      .insert(gownImages)
      .values(
        stored.map((s, i) => ({
          gownId,
          sortOrder: start + i,
          isHero: !hero && i === 0,
          originalPath: s.path,
          width: s.width,
          height: s.height,
          uploadedBy: actor.staff.id,
        })),
      )
      .returning();
    await tx.insert(imageJobs).values(rows.map((r) => ({ gownImageId: r.id })));
    await tx.insert(auditLog).values({
      occurredAt: new Date(),
      actorUserId: actor.staff.id,
      action: "gown.image_upload",
      entityType: "gown",
      entityId: gownId,
      detail: { image_ids: rows.map((r) => r.id), count: rows.length },
      ip: inetOrNull(ip),
    });

    return {
      images: rows.map((r) => ({
        id: r.id,
        sort_order: r.sortOrder,
        is_hero: r.isHero,
        alt_text: r.altText,
        width: r.width,
        height: r.height,
        status: "pending" as const,
      })),
    };
  });
}

/**
 * GET /admin/gowns/:id/images (KBS-21-2): the gallery in sort order, each
 * with its encode status, so the admin UI can poll pending → ready/failed.
 * `last_error` stays server-side: it can carry file paths.
 */
export async function listGownImages(
  gownId: string,
  db: Database = defaultDb,
): Promise<{ images: GownImage[] }> {
  const [gown] = await db.select({ id: gowns.id }).from(gowns).where(eq(gowns.id, gownId));
  if (!gown) throw new PipelineError(404, "NOT_FOUND", "Gown not found.");
  const rows = await db
    .select({
      id: gownImages.id,
      sort_order: gownImages.sortOrder,
      is_hero: gownImages.isHero,
      alt_text: gownImages.altText,
      width: gownImages.width,
      height: gownImages.height,
      // One job per image (upload inserts it, retry resets it in place).
      job: imageJobs.status,
    })
    .from(gownImages)
    .leftJoin(imageJobs, eq(imageJobs.gownImageId, gownImages.id))
    .where(eq(gownImages.gownId, gownId))
    .orderBy(asc(gownImages.sortOrder));
  return {
    images: rows.map(({ job, ...image }) => ({
      ...image,
      status: job === "done" ? "ready" : job === "failed" ? "failed" : "pending",
    })),
  };
}

/**
 * POST /admin/gowns/:id/images/:imageId/retry (KBS-21-2): a failed encode
 * goes back to pending with a fresh attempt budget. Only a failed job can be
 * retried, so a double click cannot reset a job the worker is running.
 */
export async function retryGownImage(
  gownId: string,
  imageId: string,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
): Promise<GownImage> {
  return db.transaction(async (tx) => {
    const [image] = await tx
      .select()
      .from(gownImages)
      .where(and(eq(gownImages.id, imageId), eq(gownImages.gownId, gownId)));
    if (!image) throw new PipelineError(404, "NOT_FOUND", "Photo not found.");
    const reset = await tx
      .update(imageJobs)
      .set({ status: "pending", attempts: 0, lastError: null, updatedAt: sql`now()` })
      .where(and(eq(imageJobs.gownImageId, imageId), eq(imageJobs.status, "failed")))
      .returning({ id: imageJobs.id });
    if (reset.length === 0) {
      throw new PipelineError(
        409,
        "CONFLICT",
        "Only a photo that failed to process can be retried.",
      );
    }
    await tx.insert(auditLog).values({
      occurredAt: new Date(),
      actorUserId: actor.staff.id,
      action: "gown.image_retry",
      entityType: "gown",
      entityId: gownId,
      detail: { image_id: imageId },
      ip: inetOrNull(ip),
    });
    return {
      id: image.id,
      sort_order: image.sortOrder,
      is_hero: image.isHero,
      alt_text: image.altText,
      width: image.width,
      height: image.height,
      status: "pending",
    };
  });
}
