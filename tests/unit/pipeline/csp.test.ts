import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  generateNonce,
  securityHeadersFor,
} from "../../../src/server/pipeline/headers";

describe("CSP", () => {
  it("generates a fresh URL-safe nonce", () => {
    const first = generateNonce();
    const second = generateNonce();
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second).not.toBe(first);
  });

  it("uses nonce script-src without unsafe-inline and reports violations", () => {
    const policy = contentSecurityPolicy("nonce-value");
    expect(policy).toContain("script-src 'self' 'nonce-nonce-value'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(policy).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(policy).not.toContain("font-src 'self' https://fonts.googleapis.com");
  });

  it("keeps /e/* privacy overrides with report-only CSP", () => {
    const headers = securityHeadersFor("/e/token", "abc");
    expect(headers["content-security-policy-report-only"]).toContain("nonce-abc");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
  });
});
