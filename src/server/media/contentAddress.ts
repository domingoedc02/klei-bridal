import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { env } from "@/config/env";

/**
 * Originals are named by the sha256 of their (sanitised) bytes — the server
 * chooses every path segment, so a client filename can never reach the disk
 * (no traversal, no overwrite). Stored path is relative to
 * IMAGE_ORIGINALS_PATH: `ab/cd/<64 hex>.<ext>`. Originals are never served.
 *
 * SHARED FILES: identical bytes dedupe to ONE file referenced by many
 * gown_images rows, possibly on different gowns. Image/gown delete and the
 * orphan sweep must unlink a path only when no gown_images row still names
 * it, or deleting one gown destroys another's master (security-eng, PR #30).
 */
export function originalPath(data: Buffer, ext: string): string {
  const hash = createHash("sha256").update(data).digest("hex");
  return join(hash.slice(0, 2), hash.slice(2, 4), `${hash}.${ext}`);
}

export function originalsRoot(): string {
  return resolve(env.IMAGE_ORIGINALS_PATH);
}

/**
 * Write once, atomically: temp file then hard link, which fails with EEXIST
 * instead of replacing — an identical upload dedupes onto the same file, and
 * a reader never sees a half-written original. Returns the relative path.
 */
export async function storeOriginal(data: Buffer, ext: string): Promise<string> {
  const relative = originalPath(data, ext);
  const target = join(originalsRoot(), relative);
  await mkdir(join(target, ".."), { recursive: true, mode: 0o750 });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o640, flag: "wx" });
  try {
    await link(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temp);
  }
  return relative;
}
