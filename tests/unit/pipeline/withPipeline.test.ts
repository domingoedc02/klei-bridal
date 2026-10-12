import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { budgets, type Budget } from "../../../src/server/ratelimit/budgets";
import type { RateLimitStore } from "../../../src/server/ratelimit/store";
import {
  PipelineError,
  readJson,
  readMultipart,
  mintCsrfToken,
  withPipeline,
  type PipelineOptions,
} from "../../../src/server/pipeline";
import { errorEnvelopeSchema } from "../../../src/shared/schemas/errorEnvelope";

/** `duplex` is required by undici for a stream body but missing from the DOM/Next typings. */
type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

// KBS-11-1 acceptance criteria: body limit (413), rate limit (429 / silent
// 204, fail-closed vs fail-open), error mapper (one envelope, no leaks), and
// security headers + request id on every response including errors.

const URL_ = "http://localhost:3000/api/probe";

function counterStore(): RateLimitStore {
  const counts = new Map<string, number>();
  return {
    async hit(key, windowSec) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { count, ttlSec: windowSec - 1 };
    },
  };
}

const downStore: RateLimitStore = {
  hit: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379")),
};

function post(body: BodyInit | null, headers: Record<string, string> = {}): NextRequest {
  const csrf = mintCsrfToken();
  return new NextRequest(URL_, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7",
      origin: "http://localhost:3000",
      cookie: `kbs_csrf=${csrf}`,
      "x-csrf-token": csrf,
      ...headers,
    },
    duplex: "half",
  } as NextRequestInit);
}

function staffOptions(options: Partial<PipelineOptions> = {}): Partial<PipelineOptions> {
  return {
    auth: "staff",
    sessionValidator: async (token) =>
      token === "valid-session"
        ? {
            sessionId: "session-id",
            expiresAt: new Date("2030-01-01"),
            staff: { id: "staff-id", name: "Staff", email: "staff@example.test" },
          }
        : null,
    ...options,
  };
}

function streamOf(bytes: number, chunk = 16 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const size = Math.min(chunk, bytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

const ok = async () => Response.json({ ok: true });

function wrap(
  handler: (request: NextRequest) => Promise<Response> | Response,
  options: Partial<PipelineOptions> = {},
) {
  const report = vi.fn();
  const route = withPipeline(handler, {
    auth: "public",
    rateLimit: null,
    report,
    ...options,
  });
  return { route: (request: NextRequest) => route(request, {}), report };
}

async function expectEnvelope(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = errorEnvelopeSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.request_id).toBe(response.headers.get("x-request-id"));
  return body;
}

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

describe("withPipeline — session, CSRF and authorization (KBS-11-2)", () => {
  it("rejects staff without a valid active session", async () => {
    const handler = vi.fn(ok);
    const response = await wrap(handler, staffOptions()).route(post("{}"));
    await expectEnvelope(response, 401, "UNAUTHENTICATED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks pending password sessions on non-exempt staff routes", async () => {
    const handler = vi.fn(ok);
    const response = await wrap(
      handler,
      staffOptions({
        sessionValidator: async () => ({
          sessionId: "session-id",
          expiresAt: new Date("2030-01-01"),
          staff: { id: "staff-id", name: "Staff", email: "staff@example.test" },
          passwordChangeRequired: true,
        }),
      }),
    ).route(post("{}", { cookie: `kbs_session=${"s".repeat(43)}` }));
    await expectEnvelope(response, 403, "PASSWORD_CHANGE_REQUIRED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows pending password sessions only when route opts in", async () => {
    const handler = vi.fn(ok);
    const csrf = mintCsrfToken();
    const response = await wrap(
      handler,
      staffOptions({
        allowPendingPasswordChange: true,
        sessionValidator: async () => ({
          sessionId: "session-id",
          expiresAt: new Date("2030-01-01"),
          staff: { id: "staff-id", name: "Staff", email: "staff@example.test" },
          passwordChangeRequired: true,
        }),
      }),
    ).route(
      post("{}", {
        cookie: `kbs_session=valid-session; kbs_csrf=${csrf}`,
        "x-csrf-token": csrf,
      }),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("injects an active staff principal into a staff handler", async () => {
    const handler = vi.fn(((_request: NextRequest, context: { principal: unknown }) =>
      Response.json(context)) as (request: NextRequest) => Response);
    const token = "valid-session";
    const csrf = mintCsrfToken();
    const response = await wrap(handler, staffOptions()).route(
      post("{}", {
        cookie: `kbs_session=${token}; kbs_csrf=${csrf}`,
        "x-csrf-token": csrf,
        origin: "http://localhost:3000",
      }),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects state-changing requests without CSRF", async () => {
    const handler = vi.fn(ok);
    const response = await wrap(handler).route(post("{}", { origin: "http://localhost" }));
    await expectEnvelope(response, 403, "FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts a valid double-submit token", async () => {
    const token = mintCsrfToken();
    const handler = vi.fn(ok);
    const response = await wrap(handler).route(
      post("{}", {
        cookie: `kbs_csrf=${token}`,
        "x-csrf-token": token,
        origin: "http://localhost:3000",
      }),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects cross-site origin and fetch metadata", async () => {
    const token = mintCsrfToken();
    for (const headers of [
      { origin: "https://evil.example", cookie: `kbs_csrf=${token}`, "x-csrf-token": token },
      { "sec-fetch-site": "cross-site", cookie: `kbs_csrf=${token}`, "x-csrf-token": token },
    ] as Record<string, string>[]) {
      const handler = vi.fn(ok);
      const response = await wrap(handler).route(post("{}", headers));
      await expectEnvelope(response, 403, "FORBIDDEN");
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("allows channel beacon only with same-origin metadata and no custom header", async () => {
    const request = new NextRequest("http://localhost:3000/e/link-token/channel", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "text/plain" },
      body: "{}",
    });
    const handler = vi.fn(ok);
    const response = await wrap(handler, { rateLimit: null }).route(request);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses the channel beacon when Origin is missing", async () => {
    const request = new NextRequest("http://localhost:3000/e/link-token/channel", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const handler = vi.fn(ok);
    await expectEnvelope(await wrap(handler).route(request), 403, "FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a malformed or opaque Origin", async () => {
    for (const origin of ["null", "not a url", "http://localhost:3000.evil.example"]) {
      const handler = vi.fn(ok);
      await expectEnvelope(await wrap(handler).route(post("{}", { origin })), 403, "FORBIDDEN");
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("csrf: false skips CSRF on a public route and is refused on a staff route", async () => {
    const bare = new NextRequest(URL_, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect((await wrap(ok, { csrf: false }).route(bare)).status).toBe(200);
    expect(() => wrap(ok, staffOptions({ csrf: false }))).toThrow(/public routes only/);
  });

  it("refuses a forged token and a header that does not match the cookie", async () => {
    const real = mintCsrfToken();
    const forged = `${real.split(".")[0]}.${"A".repeat(43)}`;
    for (const headers of [
      { cookie: `kbs_csrf=${forged}`, "x-csrf-token": forged },
      { cookie: `kbs_csrf=${real}`, "x-csrf-token": mintCsrfToken() },
    ]) {
      const handler = vi.fn(ok);
      await expectEnvelope(await wrap(handler).route(post("{}", headers)), 403, "FORBIDDEN");
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("skips CSRF on GET", async () => {
    const response = await wrap(ok).route(new NextRequest(URL_, { method: "GET" }));
    expect(response.status).toBe(200);
  });

  it("issues the CSRF cookie readable by JS, Path=/, SameSite=Lax, Secure outside development", async () => {
    const response = await wrap(ok).route(new NextRequest(URL_, { method: "GET" }));
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^kbs_csrf=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; /);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Secure/);
    // The client echoes it into x-csrf-token, so it must not be HttpOnly.
    expect(cookie).not.toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("does not issue a CSRF cookie on an error response, nor re-issue one already held", async () => {
    const refused = await wrap(ok).route(post("{}", { cookie: "", "x-csrf-token": "" }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();

    const held = await wrap(ok).route(
      new NextRequest(URL_, { method: "GET", headers: { cookie: `kbs_csrf=${mintCsrfToken()}` } }),
    );
    expect(held.status).toBe(200);
    expect(held.headers.get("set-cookie")).toBeNull();
  });

  const readsBody = async (request: NextRequest) => Response.json(await readJson(request));

  it("413s a JSON body whose Content-Length is over 64KB before reading it", async () => {
    const handler = vi.fn(readsBody);
    const { route } = wrap(handler);
    const response = await route(post(streamOf(10), { "content-length": String(64 * 1024 + 1) }));
    await expectEnvelope(response, 413, "PAYLOAD_TOO_LARGE");
    expect(handler).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it("413s a streamed JSON body over 64KB that carries no Content-Length", async () => {
    const request = post(streamOf(64 * 1024 + 1));
    expect(request.headers.get("content-length")).toBeNull();
    const response = await wrap(readsBody).route(request);
    await expectEnvelope(response, 413, "PAYLOAD_TOO_LARGE");
    expectSecurityHeaders(response);
  });

  it("passes a JSON body at exactly 64KB", async () => {
    const value = "a".repeat(64 * 1024 - 2);
    const response = await wrap(readsBody).route(post(JSON.stringify(value)));
    expect(response.status).toBe(200);
    expect(await response.json()).toBe(value);
  });

  it("400s malformed JSON and a wrong content-type", async () => {
    await expectEnvelope(await wrap(readsBody).route(post("{not json")), 400, "BAD_REQUEST");
    await expectEnvelope(
      await wrap(readsBody).route(post("{}", { "content-type": "text/plain" })),
      400,
      "BAD_REQUEST",
    );
  });

  describe("multipart", () => {
    const readsForm = async (request: NextRequest) => {
      const form = await readMultipart(request, limits);
      return Response.json({ files: form.getAll("file").length });
    };
    // Scaled-down limits keep the test fast; the defaults are asserted below.
    const limits = { json: 64 * 1024, multipartFileBytes: 1024, multipartFiles: 3 };

    function multipart(files: number, size: number): NextRequest {
      const form = new FormData();
      for (let i = 0; i < files; i += 1) {
        form.append("file", new File([new Uint8Array(size)], `g${i}.jpg`, { type: "image/jpeg" }));
      }
      const encoded = new Request(URL_, { method: "POST", body: form });
      const csrf = mintCsrfToken();
      return new NextRequest(URL_, {
        method: "POST",
        body: encoded.body,
        headers: {
          "content-type": encoded.headers.get("content-type") ?? "",
          origin: "http://localhost:3000",
          cookie: `kbs_csrf=${csrf}`,
          "x-csrf-token": csrf,
        },
        duplex: "half",
      } as NextRequestInit);
    }

    it("accepts files within the per-file and count limits", async () => {
      const response = await wrap(readsForm, { bodyLimits: limits }).route(multipart(3, 1024));
      expect(await response.json()).toEqual({ files: 3 });
    });

    it("413s one file over the per-file cap", async () => {
      const response = await wrap(readsForm, { bodyLimits: limits }).route(multipart(1, 1025));
      await expectEnvelope(response, 413, "PAYLOAD_TOO_LARGE");
    });

    it("413s more files than the per-request count", async () => {
      const response = await wrap(readsForm, { bodyLimits: limits }).route(multipart(4, 10));
      await expectEnvelope(response, 413, "PAYLOAD_TOO_LARGE");
    });

    it("413s a streamed multipart body over files × per-file cap + framing slack, no Content-Length", async () => {
      const csrf = mintCsrfToken();
      const request = new NextRequest(URL_, {
        method: "POST",
        body: streamOf(3 * 1024 + 64 * 1024 + 1),
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          origin: "http://localhost:3000",
          cookie: `kbs_csrf=${csrf}`,
          "x-csrf-token": csrf,
        },
        duplex: "half",
      } as NextRequestInit);
      const response = await wrap(readsForm, { bodyLimits: limits }).route(request);
      await expectEnvelope(response, 413, "PAYLOAD_TOO_LARGE");
    });

    it("defaults to 25MB per file and 10 files", async () => {
      const { defaultBodyLimits } = await import("../../../src/server/pipeline/body-limit");
      expect(defaultBodyLimits).toEqual({
        json: 64 * 1024,
        multipartFileBytes: 25 * 1024 * 1024,
        multipartFiles: 10,
      });
    });
  });
});

describe("withPipeline — rate limit (step 5)", () => {
  it("429s past the budget with Retry-After and the envelope", async () => {
    const store = counterStore();
    const { route } = wrap(ok, { rateLimit: budgets.enquirySubmit, rateLimitStore: () => store });

    for (let i = 0; i < budgets.enquirySubmit.limit; i += 1) {
      expect((await route(post("{}"))).status).toBe(200);
    }
    const limited = await route(post("{}"));
    await expectEnvelope(limited, 429, "RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expectSecurityHeaders(limited);
  });

  it("counts per client IP — the rightmost XFF entry, not a forged leftmost one", async () => {
    const store = counterStore();
    const hit = vi.spyOn(store, "hit");
    const { route } = wrap(ok, { rateLimit: budgets.enquirySubmit, rateLimitStore: () => store });
    await route(post("{}", { "x-forwarded-for": "1.2.3.4, 198.51.100.9" }));
    expect(hit).toHaveBeenCalledWith("rl:enquiry-submit:ip:198.51.100.9", 600);
  });

  it("answers the channel beacon's overflow with a silent 204 and no Retry-After", async () => {
    const store = counterStore();
    const { route } = wrap(ok, { rateLimit: budgets.enquiryChannel, rateLimitStore: () => store });
    for (let i = 0; i < budgets.enquiryChannel.limit; i += 1) await route(post("{}"));

    const dropped = await route(post("{}"));
    expect(dropped.status).toBe(204);
    expect(dropped.headers.get("retry-after")).toBeNull();
    expect(await dropped.text()).toBe("");
    expectSecurityHeaders(dropped);
  });

  it.each([
    ["enquirySubmit", budgets.enquirySubmit],
    ["sendMyList", budgets.sendMyList],
  ] as const)("fails CLOSED for %s when Valkey is unreachable", async (_name, budget: Budget) => {
    const handler = vi.fn(ok);
    const { route, report } = wrap(handler, { rateLimit: budget, rateLimitStore: () => downStore });
    const response = await route(post("{}"));
    const body = await expectEnvelope(response, 503, "SERVICE_UNAVAILABLE");
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|6379|127\.0\.0\.1/);
    expect(handler).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
    expectSecurityHeaders(response);
  });

  it.each([
    ["enquiryLink", budgets.enquiryLink],
    ["enquiryChannel", budgets.enquiryChannel],
    ["adminWrite", budgets.adminWrite],
  ] as const)("fails OPEN for %s when Valkey is unreachable", async (_name, budget: Budget) => {
    const { route } = wrap(ok, { rateLimit: budget, rateLimitStore: () => downStore });
    expect((await route(post("{}"))).status).toBe(200);
  });

  it("keys an admin session budget on a hash of the cookie, never the token itself", async () => {
    const store = counterStore();
    const hit = vi.spyOn(store, "hit");
    const { route } = wrap(ok, { rateLimit: budgets.adminWrite, rateLimitStore: () => store });
    await route(post("{}", { cookie: `kbs_session=${"s".repeat(43)}` }));
    const key = hit.mock.calls[0]?.[0] ?? "";
    expect(key).toMatch(/^rl:admin-write:session:[0-9a-f]{64}$/);
    expect(key).not.toContain("s".repeat(43));
  });

  it("keys a session budget on the IP when there is no well-formed session cookie", async () => {
    const store = counterStore();
    const hit = vi.spyOn(store, "hit");
    const { route } = wrap(ok, { rateLimit: budgets.adminWrite, rateLimitStore: () => store });
    await route(post("{}"));
    await route(post("{}", { cookie: "kbs_session=not-a-real-token" }));
    expect(hit.mock.calls.map((c) => c[0])).toEqual([
      "rl:admin-write:session:203.0.113.7",
      "rl:admin-write:session:203.0.113.7",
    ]);
  });

  it("never touches the store for rateLimit: null", async () => {
    const store = vi.fn(() => downStore);
    const { route } = wrap(ok, { rateLimit: null, rateLimitStore: store });
    expect((await route(post("{}"))).status).toBe(200);
    expect(store).not.toHaveBeenCalled();
  });
});

describe("withPipeline — error mapper (step 11)", () => {
  function pgError(code: string): Error {
    return Object.assign(
      new Error(
        `duplicate key value violates unique constraint "enquiries_email_key" — SELECT * FROM enquiries WHERE email='bride@example.com'`,
      ),
      { code, detail: "Key (email)=(bride@example.com) already exists.", table: "enquiries" },
    );
  }

  it.each([
    ["23505", 409, "CONFLICT"],
    ["23503", 409, "CONFLICT"],
    ["22P02", 400, "BAD_REQUEST"],
    ["57014", 503, "SERVICE_UNAVAILABLE"],
  ])("maps Postgres %s to %i without leaking the database message", async (state, status, code) => {
    const { route } = wrap(() => Promise.reject(pgError(state)));
    const response = await route(post("{}"));
    const body = await expectEnvelope(response, status, code);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/enquiries|SELECT|bride@example\.com|constraint|Key \(/);
    expect(body.error.fields).toBeUndefined();
    if (state === "57014") expect(response.headers.get("retry-after")).toBeTruthy();
    else expect(response.headers.get("retry-after")).toBeNull();
  });

  it("500s an unmapped error with request_id only, reporting full detail", async () => {
    const secret = new Error(
      "ENOENT: /srv/klei/.data/images/originals/x.jpg token=abc123 bride@example.com",
    );
    const { route, report } = wrap(() => {
      throw secret;
    });
    const response = await route(post("{}", { "x-request-id": "req-42" }));
    const body = await expectEnvelope(response, 500, "INTERNAL_ERROR");

    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong.", request_id: "req-42" },
    });
    expect(JSON.stringify(body)).not.toMatch(/ENOENT|\/srv|token|abc123|@|at \w+ \(/);
    expect(report).toHaveBeenCalledWith(secret, { requestId: "req-42" });
    expectSecurityHeaders(response);
  });

  it("carries fields only on a 422", async () => {
    const fields = { email: "invalid format" };
    const r422 = await wrap(() => {
      throw new PipelineError(422, "VALIDATION_ERROR", "Check the form.", { fields });
    }).route(post("{}"));
    expect((await expectEnvelope(r422, 422, "VALIDATION_ERROR")).error.fields).toEqual(fields);

    const r409 = await wrap(() => {
      throw new PipelineError(409, "CONFLICT", "Taken.", { fields });
    }).route(post("{}"));
    expect((await expectEnvelope(r409, 409, "CONFLICT")).error.fields).toBeUndefined();
  });

  it("lets Next's redirect() through as control flow, not a 500", async () => {
    const { redirect } = await import("next/navigation");
    const { route, report } = wrap(() => redirect("/admin"));
    await expect(route(post("{}"))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("withPipeline — headers on every response", () => {
  it.each(["a".repeat(65), "abc\r\nset-cookie: x", "<script>", "id with spaces"])(
    "replaces an unsafe incoming x-request-id (%s) with a fresh UUID",
    async (unsafe) => {
      const request = post("{}");
      // Headers refuses CR/LF, so set the unsafe value on a raw Headers
      // where the platform allows it, and skip values it rejects outright.
      try {
        request.headers.set("x-request-id", unsafe);
      } catch {
        return;
      }
      const response = await wrap(() => {
        throw new Error("boom");
      }).route(request);
      const id = response.headers.get("x-request-id");
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect((await response.json()).error.request_id).toBe(id);
    },
  );

  it("reuses an incoming x-request-id and generates one otherwise", async () => {
    const { route } = wrap(ok);
    expect((await route(post("{}", { "x-request-id": "abc" }))).headers.get("x-request-id")).toBe(
      "abc",
    );
    expect((await route(post("{}"))).headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("decorates a response with immutable headers (Response.redirect)", async () => {
    const response = await wrap(() => Response.redirect("http://localhost/x", 303)).route(
      post("{}"),
    );
    expect(response.status).toBe(303);
    expectSecurityHeaders(response);
  });

  it("does not overwrite a header the handler set itself", async () => {
    const response = await wrap(
      () => new Response(null, { headers: { "referrer-policy": "no-referrer" } }),
    ).route(post("{}"));
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("401s a staff route without an active session", async () => {
    const handler = vi.fn(ok);
    const response = await wrap(handler, staffOptions()).route(post("{}"));
    await expectEnvelope(response, 401, "UNAUTHENTICATED");
    expect(handler).not.toHaveBeenCalled();
  });
});
