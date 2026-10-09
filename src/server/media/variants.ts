import "server-only";
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

import { env } from "@/config/env";

export const VARIANT_WIDTHS = [320, 480, 768, 1024, 1440, 2048] as const;
type VariantFormat = "avif" | "webp" | "jpeg";
export type DerivativeManifest = Record<string, Record<string, string>>;

const QUALITY: Record<VariantFormat, number> = { avif: 52, webp: 80, jpeg: 82 };
const extension: Record<VariantFormat, string> = { avif: "avif", webp: "webp", jpeg: "jpg" };

function cacheRoot() {
  return resolve(env.IMAGE_CACHE_PATH);
}

function sourceHash(originalPath: string) {
  const match = /([a-f0-9]{64})\.[a-z]+$/i.exec(originalPath);
  if (!match) throw new Error("Original path is not content-addressed.");
  return match[1]!;
}

function derivativePath(source: string, width: number, format: VariantFormat, quality: number) {
  const digest = createHash("sha256")
    .update(`${source}:${width}:${format}:${quality}`)
    .digest("hex");
  return join(digest.slice(0, 2), digest.slice(2, 4), `${digest}.${extension[format]}`);
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeOnce(path: string, data: Buffer) {
  if (await exists(path)) return;
  await mkdir(join(path, ".."), { recursive: true, mode: 0o750 });
  try {
    await writeFile(path, data, { flag: "wx", mode: 0o640 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function encode(image: sharp.Sharp, format: VariantFormat) {
  if (format === "avif") return image.avif({ quality: QUALITY.avif, effort: 4 }).toBuffer();
  if (format === "webp") return image.webp({ quality: QUALITY.webp }).toBuffer();
  return image.jpeg({ quality: QUALITY.jpeg, progressive: true }).toBuffer();
}

/** Generate persistent, content-addressed derivatives. Existing files are no-ops. */
export async function generateVariants(originalAbsolutePath: string, originalRelativePath: string) {
  sharp.concurrency(1);
  sharp.cache(false);
  const root = cacheRoot();
  const source = sourceHash(originalRelativePath);
  const manifest: DerivativeManifest = {};
  const input = sharp(originalAbsolutePath, {
    limitInputPixels: 40_000_000,
    failOn: "warning",
  }).rotate();

  for (const width of VARIANT_WIDTHS) {
    const row = {} as Record<VariantFormat, string>;
    for (const format of ["avif", "webp", "jpeg"] as const) {
      const relative = derivativePath(source, width, format, QUALITY[format]);
      await writeOnce(
        join(root, relative),
        await encode(input.clone().resize({ width, withoutEnlargement: true }), format),
      );
      row[format] = relative;
    }
    manifest[String(width)] = row;
  }

  const lqip = await input
    .clone()
    .resize({ width: 20, withoutEnlargement: true })
    .webp({ quality: 35 })
    .toBuffer();
  return { manifest, lqip: `data:image/webp;base64,${lqip.toString("base64")}` };
}

export function variantsRoot() {
  return cacheRoot();
}
