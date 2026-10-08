import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applySecurityHeaders } from "./src/server/pipeline/headers";
import { requestIdOf } from "./src/server/pipeline/request-id";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

/**
 * Request pipeline steps 1-3 ONLY (spec/architecture): request id,
 * logging, security headers. Steps 4-11 (body limit, rate limit,
 * session, CSRF, authorization, validation, handler, error mapper) are
 * `withPipeline` (src/server/pipeline/), composed per route handler /
 * Server Action — never here. Middleware must never touch the database
 * (enforced by the boundaries lint) because it runs on every matched
 * request including /media/*.
 *
 * Security headers come from ONE registry (src/server/pipeline/headers.ts):
 * baseline set + per-route overrides (e.g. /e/*). Pages, media and route
 * handlers all get them here; withPipeline re-applies them to error
 * responses. CSP is KBS-28-2.
 */
export function middleware(request: NextRequest) {
  const requestId = requestIdOf(request.headers);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  applySecurityHeaders(response.headers, request.nextUrl.pathname);

  return response;
}
