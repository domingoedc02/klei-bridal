import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  CSP_REPORT_ONLY,
  generateNonce,
} from "./src/server/pipeline/headers";
import {
  CSRF_COOKIE,
  csrfCookieValue,
  csrfSetCookie,
  mintCsrfToken,
  validCsrfToken,
} from "./src/server/pipeline/csrf";
import { requestIdOf } from "./src/server/pipeline/request-id";
import { gownFilterQuerySchema } from "./src/shared/schemas/gownFilters";
import {
  isTaxonomyRedirectCandidate,
  taxonomyRedirectLocation,
} from "./src/server/taxonomy-redirect";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
  // node:crypto HMAC for the signed CSRF cookie (KBS-17 security review).
  runtime: "nodejs",
};

/** A page load: GET, not an API or media request. */
function isDocumentGet(request: NextRequest): boolean {
  return request.method === "GET" && !/^\/(?:api|media)\//.test(request.nextUrl.pathname);
}

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
 * responses. CSP (KBS-28-2) is report-only with one nonce per response,
 * passed to the layout as `x-nonce`.
 */
export async function middleware(request: NextRequest) {
  const requestId = requestIdOf(request.headers);
  const nonce = generateNonce();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads the nonce from the request CSP header to nonce its own inline scripts.
  requestHeaders.set(CSP_REPORT_ONLY, contentSecurityPolicy(nonce));

  // Mint the double-submit cookie on page loads, so a first-visit bride's
  // first POST carries it (KBS-17; was only minted by a <400 API response).
  let mintedCsrf: string | undefined;
  if (isDocumentGet(request) && !validCsrfToken(csrfCookieValue(request))) {
    mintedCsrf = mintCsrfToken();
    const others = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith(`${CSRF_COOKIE}=`));
    requestHeaders.set("cookie", [...others, `${CSRF_COOKIE}=${mintedCsrf}`].join("; "));
  }

  if (request.method === "GET" && isTaxonomyRedirectCandidate(request.nextUrl)) {
    const location = await taxonomyRedirectLocation(request.nextUrl);
    if (location) {
      const response = new NextResponse(null, {
        status: 301,
        headers: {
          Location: location,
          "Cache-Control": "public, max-age=86400",
        },
      });
      applySecurityHeaders(response.headers, request.nextUrl.pathname, { nonce });
      return response;
    }
  }

  if (request.method === "GET" && request.nextUrl.pathname === "/gowns") {
    const raw: Record<string, string | string[]> = {};
    for (const key of new Set(request.nextUrl.searchParams.keys())) {
      const values = request.nextUrl.searchParams.getAll(key);
      raw[key] = values.length > 1 ? values : values[0]!;
    }
    if (!gownFilterQuerySchema.safeParse(raw).success) {
      const response = NextResponse.json(
        {
          error: {
            code: "INVALID_QUERY",
            message: "Invalid catalogue query.",
            request_id: requestId,
          },
        },
        { status: 400 },
      );
      applySecurityHeaders(response.headers, request.nextUrl.pathname, { nonce });
      return response;
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  if (mintedCsrf) response.headers.append("set-cookie", csrfSetCookie(mintedCsrf));
  applySecurityHeaders(response.headers, request.nextUrl.pathname, { nonce });

  return response;
}
