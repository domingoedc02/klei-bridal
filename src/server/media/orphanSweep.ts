import "server-only";
import { readdir, rm, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { eq } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { gownImages } from "@/server/db/schema";

import { lockOriginalPath } from "./originalLock";
import { originalsRoot } from "./contentAddress";
import { socialCropPath } from "./socialCrop";
import { derivativePaths, variantsRoot } from "./variants";

const ORIGINAL = /^(?:[a-f0-9]{2}\/){2}[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|avif)$/i;

type FileEntry = { relative: string };

async function filesUnder(root: string, directory = root): Promise<FileEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, absolute)));
    else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join("/");
      if (ORIGINAL.test(path)) files.push({ relative: path });
    }
  }
  return files;
}

/**
 * Remove content-addressed originals no longer referenced by any gown image,
 * together with every derivative generated from them (decision/images §3:
 * a deleted gown's files leave the disk within one sweep interval).
 *
 * The reference check runs in a transaction and locks every matching row before
 * deciding. Shared originals therefore survive while any gown still points at
 * them. Upload failures may leave files behind; this sweep reclaims them.
 */
export async function sweepOrphanedOriginals(
  database: Database = defaultDb,
): Promise<{ scanned: number; removed: number }> {
  const candidates = await filesUnder(originalsRoot());
  let removed = 0;
  for (const candidate of candidates) {
    if (await removeOriginalIfUnreferenced(candidate.relative, database)) removed++;
  }
  return { scanned: candidates.length, removed };
}

/**
 * Remove one original and its derivatives if no gown_images row names it.
 * The reference check and the unlink share the path's advisory lock, so a
 * concurrent upload of the same bytes either sees the file or keeps it.
 * Image delete (KBS-21-4) calls this after its commit.
 */
export async function removeOriginalIfUnreferenced(
  relativePath: string,
  database: Database = defaultDb,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    await lockOriginalPath(tx, relativePath);
    const references = await tx
      .select({ id: gownImages.id })
      .from(gownImages)
      .where(eq(gownImages.originalPath, relativePath));
    if (references.length > 0) return false;

    // Derivatives first: a crash between the two leaves the original, so the next sweep retries.
    // ponytail: paths are recomputed at today's widths/qualities; files from a retired
    // width or quality stay behind. Add a manifest-diff sweep if those settings change.
    const root = variantsRoot();
    for (const path of [...derivativePaths(relativePath), socialCropPath(relativePath)])
      await rm(join(root, path), { force: true });
    try {
      await unlink(join(originalsRoot(), relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}
