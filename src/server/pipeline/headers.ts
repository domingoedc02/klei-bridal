/**
 * The ONE place security headers are decided (KBS-28-1). Middleware applies
 * them to every matched request and withPipeline applies them again to every
 * route-handler response, error responses included. Routes do not set
 * security headers themselves; they register an override here instead, so
 * the full set stays readable in one file and cannot drift per route.
 *
 * CSP is KBS-28-2 and attaches here.
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
    matches: (pathname) => pathname === "/e" || pathname.startsWith("/e/"),
    headers: {
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  },
];

/** The complete security header set for a path: baseline, then overrides. */
export function securityHeadersFor(pathname: string): Record<string, string> {
  const set = { ...baselineSecurityHeaders };
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
  { keepExisting = false }: { keepExisting?: boolean } = {},
): void {
  for (const [name, value] of Object.entries(baselineSecurityHeaders)) {
    if (!keepExisting || !headers.has(name)) headers.set(name, value);
  }
  for (const override of headerOverrides) {
    if (!override.matches(pathname)) continue;
    for (const [name, value] of Object.entries(override.headers)) headers.set(name, value);
  }
}
