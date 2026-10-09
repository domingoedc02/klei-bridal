import "server-only";
import { readdir, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { eq } from "drizzle-orm";

import { db as defaultDb, type Database } from "@/server/db/client";
import { gownImages } from "@/server/db/schema";

import { originalsRoot } from "./contentAddress";

const ORIGINAL = /^(?:[a-f0-9]{2}\/){2}[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|avif)$/i;

type FileEntry = { absolute: string; relative: string };

async function filesUnder(root: string, directory = root): Promise<FileEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FileEntry[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, absolute)));
    else if (entry.isFile()) {
      const path = relative(root, absolute).split(sep).join("/");
      if (ORIGINAL.test(path)) files.push({ absolute, relative: path });
    }
  }
  return files;
}

/**
 * Remove content-addressed originals no longer referenced by any gown image.
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
    const shouldRemove = await database.transaction(async (tx) => {
      const references = await tx
        .select({ id: gownImages.id })
        .from(gownImages)
        .where(eq(gownImages.originalPath, candidate.relative))
        .for("update");
      return references.length === 0;
    });
    if (!shouldRemove) continue;
    try {
      await unlink(candidate.absolute);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { scanned: candidates.length, removed };
}
