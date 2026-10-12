import "server-only";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

import { variantsRoot } from "./variants";

/** Cache-relative path of an original's Open Graph crop, content-addressed by source. */
export function socialCropPath(originalRelativePath: string) {
  const source = /([a-f0-9]{64})\.[a-z]+$/i.exec(originalRelativePath)?.[1];
  if (!source) throw new Error("Original path is not content-addressed.");
  return join(source.slice(0, 2), source.slice(2, 4), `${source}-social-1200x630.jpg`);
}

/** Create the JPEG Open Graph crop. */
export async function generateSocialCrop(
  originalAbsolutePath: string,
  originalRelativePath: string,
) {
  const relative = socialCropPath(originalRelativePath);
  const target = join(variantsRoot(), relative);
  try {
    await access(target);
  } catch {
    await mkdir(join(target, ".."), { recursive: true, mode: 0o750 });
    const data = await sharp(originalAbsolutePath, {
      limitInputPixels: 40_000_000,
      failOn: "warning",
    })
      .rotate()
      .resize(1200, 630, { fit: "cover", position: "attention" })
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();
    try {
      await writeFile(target, data, { flag: "wx", mode: 0o640 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return relative;
}
