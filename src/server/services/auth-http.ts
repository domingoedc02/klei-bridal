import { NextResponse } from "next/server";

import { env } from "@/config/env";

/**
 * The spec/api error envelope, for the two auth routes until the shared
 * `withPipeline` error mapper (KBS-11) exists — they then move onto it
 * and this file goes away.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra: { fields?: Record<string, string>; retryAfterSeconds?: number } = {},
) {
  const response = NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: requestId,
        ...(extra.fields ? { fields: extra.fields } : {}),
      },
    },
    { status },
  );
  if (extra.retryAfterSeconds !== undefined) {
    response.headers.set("retry-after", String(extra.retryAfterSeconds));
  }
  response.headers.set("cache-control", "no-store");
  return response;
}

export function requestIdOf(headers: Headers): string {
  return headers.get("x-request-id") ?? crypto.randomUUID();
}

/**
 * Same-origin guard for the auth POSTs (login CSRF: a cross-site form
 * signing a victim into an attacker's account). Browsers send `Origin` on
 * every POST; a request without one is not a browser form and is let
 * through to the limits like any other client. The pipeline's CSRF step
 * (KBS-11) supersedes this.
 */
export function isCrossOrigin(headers: Headers): boolean {
  if (headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = headers.get("origin");
  if (!origin) return false;
  return origin !== new URL(env.SITE_URL).origin;
}
