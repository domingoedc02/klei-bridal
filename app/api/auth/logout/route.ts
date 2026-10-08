import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, clearedSessionCookieOptions } from "@/server/auth/session";
import { signOut } from "@/server/services/auth";
import { errorResponse, isCrossOrigin, requestIdOf } from "@/server/services/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout → 204. Revokes the session ROW first, then clears
 * the cookie: a copy of the cookie taken before sign-out is dead even if
 * this response never reaches the browser. Always 204, signed in or not.
 */
export async function POST(request: NextRequest) {
  if (isCrossOrigin(request.headers)) {
    return errorResponse(
      403,
      "FORBIDDEN",
      "Cross-site request refused.",
      requestIdOf(request.headers),
    );
  }

  await signOut(request.cookies.get(SESSION_COOKIE)?.value);

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions());
  response.headers.set("cache-control", "no-store");
  return response;
}
