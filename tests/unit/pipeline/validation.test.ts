import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mintCsrfToken, withPipeline, type PipelineOptions } from "../../../src/server/pipeline";
import { MAX_FIELDS } from "../../../src/server/pipeline/validation";
import { errorEnvelopeSchema } from "../../../src/shared/schemas/errorEnvelope";
import { gownIdsSchema } from "../../../src/shared/schemas/gownIds";

// KBS-11-3: Zod validation after authorization, before the handler.

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
const SECRET = "sentinel-7f3a9c-do-not-echo";

const Body = z.object({
  first_name: z.string().min(1).max(80),
  email: z.string().email(),
  size: z.enum(["xs", "s", "m"]),
});

function post(body: string, url = "http://localhost:3000/api/probe", headers = {}) {
  const csrf = mintCsrfToken();
  return new NextRequest(url, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      cookie: `kbs_csrf=${csrf}`,
      "x-csrf-token": csrf,
      ...headers,
    },
    duplex: "half",
  } as NextRequestInit);
}

function wrap(options: Partial<PipelineOptions>) {
  const handler = vi.fn(async (_req: NextRequest, ctx: Record<string, unknown>) =>
    Response.json({ body: ctx.body, query: ctx.query, params: ctx.params }),
  );
  const route = withPipeline(handler, { auth: "public", rateLimit: null, ...options });
  return { handler, route };
}

async function envelope(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const text = await response.text();
  const parsed = errorEnvelopeSchema.parse(JSON.parse(text));
  expect(parsed.error.code).toBe(code);
  return { ...parsed.error, text };
}

const valid = { first_name: "Ana", email: "ana@example.test", size: "s" };

describe("withPipeline validation (KBS-11-3)", () => {
  it("passes parsed body, query and params to the handler", async () => {
    const { route, handler } = wrap({
      body: Body,
      query: z.object({ page: z.coerce.number().int().min(1) }),
      params: z.object({ id: z.string().uuid() }),
    });
    const id = "0192f0c1-0000-7000-8000-000000000001";
    const res = await route(post(JSON.stringify(valid), "http://localhost:3000/api/probe?page=2"), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: valid, query: { page: 2 }, params: { id } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("strips unknown keys before the handler sees them", async () => {
    const { route } = wrap({ body: Body });
    const res = await route(
      post(JSON.stringify({ ...valid, is_admin: true, status: "published" })),
    );
    expect((await res.json()).body).toEqual(valid);
  });

  it("422 VALIDATION_ERROR names each bad field and never calls the handler", async () => {
    const { route, handler } = wrap({ body: Body });
    const res = await route(post(JSON.stringify({ first_name: "", email: "nope" })));
    const error = await envelope(res, 422, "VALIDATION_ERROR");
    expect(Object.keys(error.fields ?? {}).sort()).toEqual(["email", "first_name", "size"]);
    expect(res.headers.get("x-request-id")).toBe(error.request_id);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never echoes an input value back", async () => {
    const { route } = wrap({ body: Body });
    const res = await route(
      post(JSON.stringify({ first_name: SECRET.repeat(5), email: SECRET, size: SECRET })),
    );
    const error = await envelope(res, 422, "VALIDATION_ERROR");
    expect(error.text).not.toContain(SECRET);
  });

  it("bounds the fields map: capped count, truncated keys", async () => {
    const { route } = wrap({ body: z.record(z.number()) });
    const hostile = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`${"k".repeat(300)}${i}`, "x"]),
    );
    const error = await envelope(
      await route(post(JSON.stringify(hostile))),
      422,
      "VALIDATION_ERROR",
    );
    const keys = Object.keys(error.fields ?? {});
    expect(keys.length).toBeLessThanOrEqual(MAX_FIELDS);
    expect(keys.every((k) => k.length <= 64)).toBe(true);
  });

  it("malformed JSON is 400 BAD_REQUEST, not 422", async () => {
    const { route, handler } = wrap({ body: Body });
    await envelope(await route(post("{not json")), 400, "BAD_REQUEST");
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs after CSRF: a forged request is 403 before the body is judged", async () => {
    const { route } = wrap({ body: Body });
    const res = await route(post("{not json", undefined, { "x-csrf-token": "forged" }));
    expect(res.status).toBe(403);
  });

  it("runs after authorization: an anonymous staff call is 401, not 422", async () => {
    const { route } = wrap({ auth: "staff", sessionValidator: async () => null, body: Body });
    expect((await route(post("{}"))).status).toBe(401);
  });
});

describe("gownIdsSchema", () => {
  it("accepts uuids, dedupes, refuses junk and oversize lists", () => {
    const id = "0192f0c1-0000-7000-8000-000000000001";
    expect(gownIdsSchema.parse([id, id])).toEqual([id]);
    expect(gownIdsSchema.safeParse(["1 OR 1=1"]).success).toBe(false);
    expect(gownIdsSchema.safeParse([]).success).toBe(false);
    expect(gownIdsSchema.safeParse(Array(51).fill(id)).success).toBe(false);
  });
});
