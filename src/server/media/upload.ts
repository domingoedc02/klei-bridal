import "server-only";
import sharp from "sharp";

import { PipelineError } from "@/server/pipeline/errors";

/**
 * The ONE pixel cap (decision/images §2.3): KBS-13 and KBS-21 both import it,
 * nobody retypes the number. Checked from the header before any decode.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

export type ImageFormat = "jpeg" | "png" | "webp";

export interface SanitizedImage {
  data: Buffer;
  format: ImageFormat;
  width: number;
  height: number;
}

function reject(message: string, detail?: string): never {
  throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
    fields: { files: message },
    ...(detail ? { detail } : {}),
  });
}

const ascii = (buf: Buffer, start: number, end: number) => buf.toString("latin1", start, end);

/** The file's own bytes decide its type — never the client's MIME or filename. */
export function sniff(buf: Buffer): ImageFormat | "heif" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "png";
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") {
    return "webp";
  }
  if (buf.length >= 12 && ascii(buf, 4, 8) === "ftyp") return "heif";
  return null;
}

/**
 * Validate one upload and return a clean master: type by magic bytes, the
 * 40 MP cap from the header only, a full decode to prove it is not corrupt,
 * and a re-encode that drops EXIF/GPS/XMP (orientation is applied first, so
 * nothing is lost but the metadata). The re-encode also drops anything
 * appended to a polyglot file, since only decoded pixels are written back.
 *
 * ponytail: JPEG/WebP masters are re-encoded at q95 4:4:4 (PNG stays
 * lossless) — one generation, invisible at derivative sizes; a lossless
 * segment strip would keep the bytes but cannot apply EXIF orientation.
 */
export async function sanitizeImage(buf: Buffer): Promise<SanitizedImage> {
  const sniffed = sniff(buf);
  if (sniffed === "heif") {
    // ponytail: the prebuilt libvips has no HEVC decoder. iOS Safari converts
    // HEIC to JPEG on upload; a custom libvips build would lift this.
    reject("HEIC photos are not supported yet. Export the photo as JPEG and upload it again.");
  }
  if (!sniffed) reject("Upload a JPEG, PNG or WebP photo.");

  let meta: sharp.Metadata;
  try {
    // limitInputPixels makes metadata() refuse an oversized header without
    // decoding a single pixel (AC 7, decision/images §5).
    meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel limit/i.test(message)) {
      reject("Photos can be at most 40 megapixels.", message);
    }
    reject("This file is not a readable photo.", message);
  }
  if (meta.format !== sniffed || !meta.width || !meta.height) {
    reject("This file is not a readable photo.", `sniffed ${sniffed}, sharp ${meta.format}`);
  }
  if (meta.width * meta.height > MAX_INPUT_PIXELS) reject("Photos can be at most 40 megapixels.");

  try {
    const pipeline = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" })
      .rotate()
      .keepIccProfile();
    const encoded =
      sniffed === "png"
        ? pipeline.png()
        : sniffed === "webp"
          ? pipeline.webp({ quality: 95, smartSubsample: true })
          : pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { data, format: sniffed, width: info.width, height: info.height };
  } catch (error) {
    reject("This photo is damaged or incomplete.", String(error));
  }
}
