import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { variantsRoot } from "@/server/media/variants";

const SAFE_PATH =
  /^(?:[a-f0-9]{2}\/){2}[a-f0-9]{64}(?:\.(?:avif|webp)|(?:-social-1200x630)?\.jpg)$/;
const CONTENT_TYPE: Record<string, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpg: "image/jpeg",
};

function safeVariantPath(path: string[]): { absolute: string; type: string } | null {
  const relative = path.join("/");
  if (!SAFE_PATH.test(relative)) return null;
  const extension = relative.slice(relative.lastIndexOf(".") + 1);
  const root = variantsRoot();
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(`${root}/`)) return null;
  return { absolute, type: CONTENT_TYPE[extension]! };
}

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const target = safeVariantPath((await context.params).path);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const body = await readFile(target.absolute);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": target.type,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
