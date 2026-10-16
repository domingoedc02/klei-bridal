import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "@/config/env";

import { PipelineError } from "./errors";

export const CSRF_COOKIE = "kbs_csrf";
export const CSRF_HEADER = "x-csrf-token";

const TOKEN_BYTES = 32;

function signature(token: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(token).digest("base64url");
}

/** Cookie value is opaque to the browser, but cannot be forged with a chosen token. */
export function mintCsrfToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return `${token}.${signature(token)}`;
}

export function validCsrfToken(value: string | undefined): boolean {
  if (!value) return false;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;
  const token = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const expected = signature(token);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function requireSameOrigin(request: Request, requireOrigin = false): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
  }
  const origin = request.headers.get("origin");
  if (!origin) {
    if (requireOrigin) throw new PipelineError(403, "FORBIDDEN", "Origin is required.");
    return;
  }
  try {
    if (new URL(origin).origin === new URL(env.SITE_URL).origin) return;
  } catch {
    // Invalid Origin is not same-origin.
  }
  throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
}

export function csrfCookieValue(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`))
    ?.slice(CSRF_COOKIE.length + 1);
}

export function isStateChanging(request: Request): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase());
}

/** Exactly one documented sendBeacon exception. */
export function isChannelBeacon(request: Request): boolean {
  return /^\/(?:api\/)?e\/[^/]+\/channel\/?$/.test(new URL(request.url).pathname);
}

export function requireCsrf(request: Request): void {
  requireSameOrigin(request);

  const cookie = csrfCookieValue(request);
  const header = request.headers.get(CSRF_HEADER);
  if (!validCsrfToken(cookie) || !header || header !== cookie) {
    throw new PipelineError(403, "FORBIDDEN", "CSRF validation failed.");
  }
}

/**
 * Form-encoded POST (KBS-89, decision/enquiry-nojs-csrf): double-submit with the
 * hidden `csrf_token` field in place of the header. Origin is REQUIRED here —
 * a native form post always sends it — and cross-site fetches are refused.
 */
export function requireFormCsrf(request: Request, field: string | null): void {
  requireSameOrigin(request, true);
  const cookie = csrfCookieValue(request);
  if (!validCsrfToken(cookie) || !field) {
    throw new PipelineError(403, "FORBIDDEN", "CSRF validation failed.");
  }
  const a = Buffer.from(field);
  const b = Buffer.from(cookie!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PipelineError(403, "FORBIDDEN", "CSRF validation failed.");
  }
}

export function csrfSetCookie(value: string): string {
  const secure = env.NODE_ENV !== "development" ? "; Secure" : "";
  return `${CSRF_COOKIE}=${value}; Path=/; SameSite=Lax${secure}`;
}
