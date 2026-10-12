import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "../../../middleware";
import {
  HSTS,
  headerOverrides,
  securityHeadersFor,
  applySecurityHeaders,
} from "../../../src/server/pipeline/headers";
import { withPipeline } from "../../../src/server/pipeline";

// KBS-28-1: one header mechanism, global baseline + per-route override
// registry, HSTS short and without preload.

const BASELINE = {
  "strict-transport-security": HSTS,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

describe("security header registry", () => {
  it("starts HSTS short (≤ 1 day), with no preload", () => {
    const maxAge = Number(/max-age=(\d+)/.exec(HSTS)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(86400);
    expect(HSTS).not.toMatch(/preload/i);
  });

  it.each([
    "/",
    "/gowns/a-line-lace",
    "/admin/enquiries",
    "/media/x.avif",
    "/api/enquiries",
    "/eve",
  ])("applies exactly the baseline on %s", (path) => {
    expect(securityHeadersFor(path)).toEqual(BASELINE);
  });

  it.each(["/e/abc123", "/e/abc123/channel", "/e"])(
    "overrides Referrer-Policy and adds X-Robots-Tag on %s",
    (path) => {
      expect(securityHeadersFor(path)).toEqual({
        ...BASELINE,
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      });
    },
  );

  it("never emits a CORS allow-origin header anywhere", () => {
    for (const path of ["/", "/e/x", "/api/x"]) {
      expect(Object.keys(securityHeadersFor(path))).not.toContain("access-control-allow-origin");
    }
    for (const override of headerOverrides) {
      expect(Object.keys(override.headers)).not.toContain("access-control-allow-origin");
    }
  });

  it("keepExisting leaves a header the response already set", () => {
    const headers = new Headers({ "x-frame-options": "SAMEORIGIN" });
    applySecurityHeaders(headers, "/", { keepExisting: true });
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    applySecurityHeaders(headers, "/");
    expect(headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("/e/* always ends with Referrer-Policy: no-referrer", () => {
  it.each([
    "unsafe-url",
    "origin",
    "strict-origin-when-cross-origin",
    "no-referrer-when-downgrade",
  ])("even when the handler sets %s itself, on success and on error", async (policy) => {
    const setsPolicy = withPipeline(
      () => new Response("ok", { headers: { "referrer-policy": policy, "x-robots-tag": "all" } }),
      { auth: "public", rateLimit: null, report: () => {} },
    );
    const fails = withPipeline(
      () => {
        throw new Error("boom");
      },
      { auth: "public", rateLimit: null, report: () => {} },
    );
    for (const route of [setsPolicy, fails]) {
      const response = await route(new NextRequest("http://localhost/e/tok"), {});
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("applySecurityHeaders with keepExisting still forces the override", () => {
    const headers = new Headers({ "referrer-policy": "unsafe-url" });
    applySecurityHeaders(headers, "/e/tok", { keepExisting: true });
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("headers are applied by the shared mechanism", () => {
  it("middleware sets the full set and the request id on a page", () => {
    const response = middleware(new NextRequest("http://localhost/gowns"));
    for (const [name, value] of Object.entries(BASELINE)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("middleware mints a signed kbs_csrf on a first page load, forwards it, and leaves a valid one alone", () => {
    const first = middleware(new NextRequest("http://localhost/enquire"));
    const token = /kbs_csrf=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(first.headers.get("x-middleware-request-cookie")).toContain(`kbs_csrf=${token}`);
    const again = middleware(new NextRequest("http://localhost/enquire", { headers: { cookie: `kbs_csrf=${token}` } }));
    expect(again.headers.get("set-cookie")).toBeNull();
    const forged = middleware(new NextRequest("http://localhost/enquire", { headers: { cookie: "kbs_csrf=x.y" } }));
    expect(forged.headers.get("set-cookie")).toContain("kbs_csrf=");
    expect(middleware(new NextRequest("http://localhost/api/enquiries")).headers.get("set-cookie")).toBeNull();
  });

  it("middleware applies the /e/* override", () => {
    const response = middleware(new NextRequest("http://localhost/e/tok"));
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("withPipeline applies the /e/* override to an error response too", async () => {
    const route = withPipeline(
      () => {
        throw new Error("boom");
      },
      { auth: "public", rateLimit: null, report: () => {} },
    );
    const response = await route(
      // Same-origin: the beacon's Origin check (KBS-11-2) runs before the handler.
      new NextRequest("http://localhost:3000/e/tok/channel", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      }),
      {},
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("strict-transport-security")).toBe(HSTS);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
