import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, clearedSessionCookieOptions } from "@/server/auth/session";
import { clientIp } from "@/server/ratelimit/client-ip";
import { signOut } from "@/server/services/auth";
import { isCrossOrigin } from "@/server/services/auth-http";
import { PipelineError, withPipeline } from "@/server/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request: NextRequest) {
  if (isCrossOrigin(request.headers)) {
    throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
  }

  await signOut(request.cookies.get(SESSION_COOKIE)?.value, clientIp(request.headers));

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions());
  response.headers.set("cache-control", "no-store");
  return response;
}

export const POST = withPipeline(handler, {
  auth: "staff",
  rateLimit: null,
  allowPendingPasswordChange: true,
});
