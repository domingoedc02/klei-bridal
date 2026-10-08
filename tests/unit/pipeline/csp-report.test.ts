import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  cspReportBodyLimits,
  cspReportHandler,
  sanitizeReport,
} from "../../../app/api/csp-report/route";
import { budgets } from "../../../src/server/ratelimit/budgets";
import { withPipeline, type PipelineOptions } from "../../../src/server/pipeline";
import type { RateLimitStore } from "../../../src/server/ratelimit/store";

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
const URL_ = "http://localhost/api/csp-report";
const okStore: RateLimitStore = {
  hit: async () => ({ count: 1, ttlSec: 59 }),
};

const options = (rateLimitStore: RateLimitStore): PipelineOptions => ({
  auth: "public",
  csrf: false,
  rateLimit: budgets.cspReport,
  rateLimitStore: () => rateLimitStore,
  bodyLimits: cspReportBodyLimits,
});

function POST(request: NextRequest, pipelineOptions: PipelineOptions) {
  return withPipeline(cspReportHandler, pipelineOptions)(request, {});
}

function request(
  body: string,
  contentType = "application/csp-report",
  headers: Record<string, string> = {},
) {
  return new NextRequest(URL_, {
    method: "POST",
    body,
    headers: { "content-type": contentType, "x-real-ip": "203.0.113.7", ...headers },
    duplex: "half",
  } as NextRequestInit);
}

describe("CSP report sink", () => {
  it("rejects wrong and parameterized media types", async () => {
    expect((await POST(request("{}", "application/json"), options(okStore))).status).toBe(415);
    expect(
      (await POST(request("{}", "application/csp-report; charset=utf-8"), options(okStore))).status,
    ).toBe(415);
  });

  it("rejects oversized declared and streamed bodies before JSON parsing", async () => {
    const oversized = "x".repeat(16 * 1024 + 1);
    expect(
      (
        await POST(
          request(oversized, "application/csp-report", {
            "content-length": String(oversized.length),
          }),
          options(okStore),
        )
      ).status,
    ).toBe(413);
    expect((await POST(request(oversized), options(okStore))).status).toBe(413);
  });

  it("strips unknown fields and logs only bounded counts", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(
      request(
        JSON.stringify({
          "document-uri": "https://example.test",
          unknown: "secret",
          "original-policy": "a",
        }),
      ),
      options(okStore),
    );
    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledWith("csp_violation", {
      request_id: expect.any(String),
      string_fields: 2,
      numeric_fields: 0,
      reports: 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    log.mockRestore();
  });

  it("never logs an unvalidated x-request-id", async () => {
    // Fetch Headers already refuse CR/LF, so markup and size are what reach the route.
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const hostile of ["<script>alert(1)</script>", "a".repeat(65)]) {
      const response = await POST(
        request(JSON.stringify({ "document-uri": "https://example.test" }), undefined, {
          "x-request-id": hostile,
        }),
        options(okStore),
      );
      expect(response.status).toBe(200);
      expect(JSON.stringify(log.mock.calls)).not.toContain(hostile);
    }
    const requestIds = log.mock.calls.map(
      ([, entry]) => (entry as { request_id: string }).request_id,
    );
    for (const id of requestIds) expect(id).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    log.mockRestore();
  });

  it("rejects malformed shape and oversized fields", async () => {
    expect(sanitizeReport({ nope: 1 })).toEqual({
      stringFields: 0,
      numericFields: 0,
      reports: 1,
    });
    expect(
      (await POST(request(JSON.stringify({ "document-uri": "x".repeat(513) })), options(okStore)))
        .status,
    ).toBe(400);
    expect((await POST(request("not json"), options(okStore))).status).toBe(400);
  });

  it("returns 429 and 503 for rate-limit failures", async () => {
    const limited: RateLimitStore = { hit: async () => ({ count: 31, ttlSec: 12 }) };
    expect((await POST(request("{}"), options(limited))).status).toBe(429);
    const down: RateLimitStore = { hit: async () => Promise.reject(new Error("down")) };
    const response = await POST(request("{}"), options(down));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });
});
