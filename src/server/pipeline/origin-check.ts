import { env } from "@/config/env";

import { PipelineError } from "./errors";

/**
 * The control that REPLACES CSRF on `POST /e/:token/channel` (KBS-29-4).
 * sendBeacon cannot carry the CSRF header, so this check is not optional
 * defence in depth: it is the only thing standing between a forged
 * cross-site POST and the write.
 *
 * Stricter than requireSameOrigin: a browser always sends both headers on a
 * same-origin beacon, so BOTH must say same-origin. `same-site` (a sibling
 * subdomain), `cross-site` and `none` are refused, a missing or opaque
 * ("null") Origin is refused, and so is any Origin that is not SITE_URL's.
 * It throws before any token lookup or write.
 */
export function requireChannelOrigin(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
  }
  const origin = request.headers.get("origin");
  if (!origin) throw new PipelineError(403, "FORBIDDEN", "Origin is required.");
  try {
    if (new URL(origin).origin === new URL(env.SITE_URL).origin) return;
  } catch {
    // Opaque or malformed Origin is not same-origin.
  }
  throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
}
