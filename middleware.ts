import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
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
 * The full security header set (HSTS, CSP, the /e/* Referrer-Policy and
 * X-Robots-Tag overrides) is KBS-28's scope. This stub carries the
 * request id and one uncontroversial baseline header so that work has
 * somewhere to attach without a structural change.
 */
export function middleware(request: NextRequest) {
  const requestId = requestIdOf(request.headers);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  response.headers.set("x-content-type-options", "nosniff");

  return response;
}
