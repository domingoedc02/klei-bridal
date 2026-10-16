/**
 * The ONE place security headers are decided (KBS-28-1). Middleware applies
 * them to every matched request and withPipeline applies them again to every
 * route-handler response, error responses included. Routes do not set
 * security headers themselves; they register an override here instead, so
 * the full set stays readable in one file and cannot drift per route.
 *
 * CSP (KBS-28-2) is report-only and nonce-based; the nonce comes from middleware.
 */

/**
 * HSTS starts deliberately SHORT, with no `preload` (KBS-28-1, devops +
 * security-eng). Traefik terminates TLS (Let's Encrypt under Dokploy); the
 * app only emits the header. On a single box, a failed renewal plus a long,
 * client-cached max-age means the site is unreachable, not just degraded.
 * ponytail: raise to spec/security's `max-age=63072000; includeSubDomains`
 * after the first clean production renewal. Add `preload` only after
 * renewals have run clean for a sustained period.
 */
export const HSTS = "max-age=300; includeSubDomains";

export const baselineSecurityHeaders: Readonly<Record<string, string>> = {
  "strict-transport-security": HSTS,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export interface HeaderOverride {
  /** Why the route differs, for the reviewer reading this file. */
  reason: string;
  matches: (pathname: string) => boolean;
  headers: Readonly<Record<string, string>>;
}

/** Per-route overrides, applied after the baseline. A later entry wins over an earlier one. */
export const headerOverrides: readonly HeaderOverride[] = [
  {
    // KBS-29 / spec/api: the enquiry short link must never leak its token
    // in a Referer and must never be indexed.
    reason: "enquiry short link /e/:token (KBS-29)",
    matches: (pathname) =>
      pathname === "/e" || pathname.startsWith("/e/") || pathname === "/api/e" || pathname.startsWith("/api/e/"),
    headers: {
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  },
  {
    // KBS-89: the form carries a per-visitor CSRF token and the confirmation
    // carries her reference — neither may be cached or indexed.
    reason: "enquiry form and its confirmation (KBS-89)",
    matches: (pathname) => pathname === "/enquire" || pathname === "/enquire/sent",
    headers: {
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  },
  {
    reason: "admin reset password token (KBS-91)",
    matches: (pathname) => pathname === "/admin/reset-password",
    headers: {
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  },
];

export const CSP_REPORT_ONLY = "content-security-policy-report-only";

/**
 * Report-only first: there is no staging environment, so collect violations on
 * real pages before enforcing. `script-src` never permits unsafe-inline.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-report",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Web Crypto keeps nonce generation compatible with Next middleware's Edge runtime. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The complete security header set for a path: baseline (+ CSP when a nonce is given), then overrides. */
export function securityHeadersFor(pathname: string, nonce?: string): Record<string, string> {
  const set: Record<string, string> = { ...baselineSecurityHeaders };
  if (nonce) set[CSP_REPORT_ONLY] = contentSecurityPolicy(nonce);
  for (const override of headerOverrides) {
    if (override.matches(pathname)) Object.assign(set, override.headers);
  }
  return set;
}

/**
 * Applies the set for `pathname`. With `keepExisting`, a BASELINE header the
 * response already carries is left alone (withPipeline: a handler may pick
 * its own value). A per-route override is ALWAYS enforced, so a handler can
 * never loosen it, e.g. put a Referer-leaking policy on /e/*.
 */
export function applySecurityHeaders(
  headers: Headers,
  pathname: string,
  { keepExisting = false, nonce }: { keepExisting?: boolean; nonce?: string } = {},
): void {
  const base: Record<string, string> = { ...baselineSecurityHeaders };
  if (nonce) base[CSP_REPORT_ONLY] = contentSecurityPolicy(nonce);
  for (const [name, value] of Object.entries(base)) {
    if (!keepExisting || !headers.has(name)) headers.set(name, value);
  }
  for (const override of headerOverrides) {
    if (!override.matches(pathname)) continue;
    for (const [name, value] of Object.entries(override.headers)) headers.set(name, value);
  }
}
