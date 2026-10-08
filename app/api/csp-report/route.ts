import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withPipeline } from "@/server/pipeline";

const MAX_REPORT_BYTES = 16 * 1024;

/**
 * CSP report-only sink. KBS-33 will replace this with structured persistence;
 * for now keep reports bounded and route a redacted event to server logging.
 */
async function handler(request: NextRequest): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.includes("application/csp-report") &&
    !contentType.includes("application/json")
  ) {
    return new Response(null, { status: 415 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES) {
    return new Response(null, { status: 413 });
  }

  try {
    const report = JSON.parse(body) as unknown;
    console.info("csp_violation", { report });
  } catch {
    return new Response(null, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

export const POST = withPipeline(handler, { auth: "public", rateLimit: null });
