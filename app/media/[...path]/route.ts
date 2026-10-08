import { NextResponse } from "next/server";

/**
 * Serves image derivatives from the kbs-media volume (IMAGE_CACHE_PATH)
 * with immutable caching (spec/architecture). Structural stub — real
 * implementation lands with the image pipeline (KBS-13).
 */
export async function GET() {
  return NextResponse.json(
    { error: { code: "NOT_IMPLEMENTED", message: "Image serving lands with KBS-13." } },
    { status: 501 },
  );
}
