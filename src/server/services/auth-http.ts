import { env } from "@/config/env";

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
