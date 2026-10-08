/**
 * Baseline security headers, applied by the pipeline so they are present on
 * error responses too — a 429 or 500 shipping without them is a gap that
 * only appears under failure (KBS-11-1).
 *
 * HSTS, CSP and the `/e/*` overrides are KBS-28's scope and attach here.
 */
export const baselineSecurityHeaders: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
];

/** Sets the baseline set without overwriting a header the route chose itself. */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of baselineSecurityHeaders) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
