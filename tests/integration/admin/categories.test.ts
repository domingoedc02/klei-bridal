import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as collectionsRoute from "../../../app/api/admin/collections/route";
import * as materialsRoute from "../../../app/api/admin/materials/route";
import * as silhouettesRoute from "../../../app/api/admin/silhouettes/route";
import * as silhouetteRoute from "../../../app/api/admin/silhouettes/[id]/route";
import * as materialRoute from "../../../app/api/admin/materials/[id]/route";
import * as collectionRoute from "../../../app/api/admin/collections/[id]/route";
import * as silhouetteMerge from "../../../app/api/admin/silhouettes/[id]/merge/route";
import * as materialMerge from "../../../app/api/admin/materials/[id]/merge/route";
import * as collectionMerge from "../../../app/api/admin/collections/[id]/merge/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { csrfHeaders } from "../csrf-headers";

/**
 * KBS-22-1 through the real routes and Postgres 17: auth, CSRF, create,
 * list, rename, exact duplicate (409), near duplicate (pg_trgm), 422 and
 * the audit row; KBS-22-2 delete (refused in use) and merge. Names are random hex so no seed or earlier row is "similar".
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

const IP = "203.0.113.9";
let staffId: string;
let cookie: string;
const gownIds: string[] = [];

const name = () => `v${randomUUID().replace(/-/g, "")}`;

function request(path: string, method = "GET", body?: unknown, withCsrf = true) {
  const session = `${SESSION_COOKIE}=${cookie}`;
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(withCsrf ? csrfHeaders(session) : { cookie: session }),
      "content-type": "application/json",
      "x-real-ip": IP,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const create = (body: unknown) =>
  silhouettesRoute.POST(request("/api/admin/silhouettes", "POST", body));
const rename = (id: string, body: unknown) =>
  silhouetteRoute.PATCH(request(`/api/admin/silhouettes/${id}`, "PATCH", body), {
    params: Promise.resolve({ id }),
  } as never);

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Vocab Test', ${`vocab-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  cookie = (await createSession(db, { staffUserId: staffId, ip: null, userAgent: null })).token;
});

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds})`;
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${staffId}`;
  for (const table of ["silhouettes", "materials", "collections"] as const) {
    await sql`DELETE FROM ${sql(table)} WHERE created_by = ${staffId}`;
  }
  await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("auth and CSRF", () => {
  it("refuses a request with no session (401)", async () => {
    const res = await silhouettesRoute.GET(
      new NextRequest("http://localhost:3000/api/admin/silhouettes"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a write without the CSRF token, and writes nothing", async () => {
    const n = name();
    const res = await silhouettesRoute.POST(
      request("/api/admin/silhouettes", "POST", { name: n }, false),
    );
    expect(res.status).toBe(403);
    expect(await sql`SELECT 1 FROM silhouettes WHERE name = ${n}`).toHaveLength(0);
  });
});

describe("create and list", () => {
  it.each([
    ["silhouettes", silhouettesRoute, "silhouette"],
    ["materials", materialsRoute, "material"],
    ["collections", collectionsRoute, "collection"],
  ] as const)(
    "creates a %s value (201) with a slug and an audit row",
    async (type, route, entity) => {
      const n = name();
      const res = await route.POST(request(`/api/admin/${type}`, "POST", { name: `  ${n}  ` }));
      expect(res.status).toBe(201);
      const item = await res.json();
      expect(item).toMatchObject({ name: n, slug: n, gown_count: 0, is_active: true });

      const audit = await sql`
      SELECT action, entity_type, host(ip) AS ip FROM audit_log WHERE entity_id = ${item.id}
    `;
      expect(audit).toEqual([{ action: `${entity}.create`, entity_type: entity, ip: IP }]);

      const list = await (await route.GET(request(`/api/admin/${type}`))).json();
      expect(list.items).toContainEqual(expect.objectContaining({ id: item.id, gown_count: 0 }));
    },
  );

  it("counts the gowns that use a value", async () => {
    const item = await (await create({ name: name() })).json();
    const gownId = randomUUID();
    await sql`
      INSERT INTO gowns (id, slug, name, status, silhouette_id, created_by, updated_by)
      VALUES (${gownId}, ${`vocab-${gownId}`}, 'Vocab gown', 'draft', ${item.id}, ${staffId}, ${staffId})
    `;
    gownIds.push(gownId);
    const list = await (await silhouettesRoute.GET(request("/api/admin/silhouettes"))).json();
    expect(list.items).toContainEqual(expect.objectContaining({ id: item.id, gown_count: 1 }));
  });
});

describe("duplicates", () => {
  it("answers an exact case/space-insensitive match with 409 CONFLICT", async () => {
    const n = name();
    expect((await create({ name: n })).status).toBe(201);
    const res = await create({ name: `  ${n.toUpperCase()} ` });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain(n);
  });

  it("warns on a near duplicate, writes nothing, then creates on confirm", async () => {
    const n = name();
    const first = await (await create({ name: n })).json();
    const near = `${n}x`;

    const warned = await create({ name: near });
    expect(warned.status).toBe(409);
    const body = await warned.json();
    expect(body.error.code).toBe("NEAR_DUPLICATE");
    expect(body.suggestion).toEqual({ id: first.id, name: n, slug: first.slug });
    expect(await sql`SELECT 1 FROM silhouettes WHERE name = ${near}`).toHaveLength(0);

    const confirmed = await create({ name: near, confirm_near_duplicate: true });
    expect(confirmed.status).toBe(201);
  });
});

describe("validation", () => {
  it.each([[""], ["   "], ["a".repeat(121)]])("rejects name %j with 422", async (bad) => {
    const res = await create({ name: bad });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toHaveProperty("name");
  });

  it("rejects a non-uuid id with 422", async () => {
    expect((await rename("not-a-uuid", { name: name() })).status).toBe(422);
  });
});

describe("rename", () => {
  it("renames (200), keeps the slug, and audits the update", async () => {
    const item = await (await create({ name: name() })).json();
    const next = name();
    const res = await rename(item.id, { name: next });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: item.id, name: next, slug: item.slug });
    const audit = await sql`
      SELECT action, host(ip) AS ip FROM audit_log
      WHERE entity_id = ${item.id} ORDER BY occurred_at
    `;
    expect(audit).toEqual([
      { action: "silhouette.create", ip: IP },
      { action: "silhouette.update", ip: IP },
    ]);
  });

  it("allows a case-only rename of itself", async () => {
    const n = name();
    const item = await (await create({ name: n })).json();
    expect((await rename(item.id, { name: n.toUpperCase() })).status).toBe(200);
  });

  it("answers a rename onto another value's name with 409", async () => {
    const a = await (await create({ name: name() })).json();
    const b = await (await create({ name: name() })).json();
    const res = await rename(b.id, { name: a.name });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("answers an unknown id with 404", async () => {
    expect((await rename(randomUUID(), { name: name() })).status).toBe(404);
  });

  it("refuses a rename without the CSRF token", async () => {
    const item = await (await create({ name: name() })).json();
    const res = await silhouetteRoute.PATCH(
      request(`/api/admin/silhouettes/${item.id}`, "PATCH", { name: name() }, false),
      { params: Promise.resolve({ id: item.id }) } as never,
    );
    expect(res.status).toBe(403);
  });
});

const ITEM = {
  silhouettes: silhouetteRoute,
  materials: materialRoute,
  collections: collectionRoute,
};
const MERGE = {
  silhouettes: silhouetteMerge,
  materials: materialMerge,
  collections: collectionMerge,
};
const ROUTES = {
  silhouettes: silhouettesRoute,
  materials: materialsRoute,
  collections: collectionsRoute,
};
type Type = keyof typeof ITEM;
const ENTITY = { silhouettes: "silhouette", materials: "material", collections: "collection" };
const LINK = {
  materials: ["gown_materials", "material_id"],
  collections: ["gown_collections", "collection_id"],
} as const;

const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const make = async (type: Type) =>
  (await (await ROUTES[type].POST(request(`/api/admin/${type}`, "POST", { name: name() }))).json())
    .id as string;
const remove = (type: Type, id: string, withCsrf = true) =>
  ITEM[type].DELETE(request(`/api/admin/${type}/${id}`, "DELETE", undefined, withCsrf), params(id));
const merge = (type: Type, id: string, body: unknown, withCsrf = true) =>
  MERGE[type].POST(request(`/api/admin/${type}/${id}/merge`, "POST", body, withCsrf), params(id));

/** A draft gown on `silhouette`, tagged with each [type, id] in `tags`. */
async function gown(silhouette: string, tags: [keyof typeof LINK, string][] = []) {
  const id = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, silhouette_id, created_by, updated_by)
    VALUES (${id}, ${`vocab-${id}`}, 'Vocab gown', 'draft', ${silhouette}, ${staffId}, ${staffId})
  `;
  gownIds.push(id);
  for (const [type, value] of tags) {
    const [table, col] = LINK[type];
    await sql`INSERT INTO ${sql(table)} (gown_id, ${sql(col)}) VALUES (${id}, ${value})`;
  }
  return id;
}

describe("delete (KBS-22-2)", () => {
  it.each(["silhouettes", "materials", "collections"] as const)(
    "deletes an unused %s value (204) and audits it",
    async (type) => {
      const id = await make(type);
      const res = await remove(type, id);
      expect(res.status).toBe(204);
      expect(await sql`SELECT 1 FROM ${sql(type)} WHERE id = ${id}`).toHaveLength(0);
      const audit = await sql`
        SELECT action, entity_type, host(ip) AS ip FROM audit_log
        WHERE entity_id = ${id} AND action LIKE '%.delete'
      `;
      expect(audit).toEqual([
        { action: `${ENTITY[type]}.delete`, entity_type: ENTITY[type], ip: IP },
      ]);
    },
  );

  it("refuses a value in use with 409, the gown count and the options", async () => {
    const sil = await make("silhouettes");
    const mat = await make("materials");
    await gown(sil, [["materials", mat]]);
    await gown(sil, [["materials", mat]]);

    const res = await remove("materials", mat);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("IN_USE");
    expect(body).toMatchObject({ gown_count: 2, options: ["merge", "deactivate"] });
    expect(await sql`SELECT 1 FROM materials WHERE id = ${mat}`).toHaveLength(1);
    expect((await remove("silhouettes", sil)).status).toBe(409);
  });

  it("answers an unknown id with 404", async () => {
    expect((await remove("collections", randomUUID())).status).toBe(404);
  });

  it("refuses a delete without the CSRF token, and keeps the value", async () => {
    const id = await make("collections");
    expect((await remove("collections", id, false)).status).toBe(403);
    expect(await sql`SELECT 1 FROM collections WHERE id = ${id}`).toHaveLength(1);
  });

  it("refuses a delete with no session (401)", async () => {
    const id = await make("collections");
    const res = await collectionRoute.DELETE(
      new NextRequest(`http://localhost:3000/api/admin/collections/${id}`, {
        method: "DELETE",
        headers: csrfHeaders(),
      }),
      params(id),
    );
    expect(res.status).toBe(401);
  });
});

describe("merge (KBS-22-2)", () => {
  it.each(["materials", "collections"] as const)(
    "moves every gown from A to B, dedupes a gown with both, deletes A, one audit row (%s)",
    async (type) => {
      const sil = await make("silhouettes");
      const a = await make(type);
      const b = await make(type);
      const both = await gown(sil, [
        [type, a],
        [type, b],
      ]);
      const onlyA = [await gown(sil, [[type, a]]), await gown(sil, [[type, a]])];

      const res = await merge(type, a, { target_id: b });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ moved_count: 3 });

      const [table, col] = LINK[type];
      const onB = await sql`SELECT gown_id FROM ${sql(table)} WHERE ${sql(col)} = ${b}`;
      expect(onB.map((r) => r.gown_id).sort()).toEqual([both, ...onlyA].sort());
      expect(await sql`SELECT 1 FROM ${sql(table)} WHERE ${sql(col)} = ${a}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM ${sql(type)} WHERE id = ${a}`).toHaveLength(0);

      const audit = await sql`
        SELECT action, entity_id, detail, host(ip) AS ip FROM audit_log
        WHERE action = ${`${ENTITY[type]}.merge`} AND entity_id = ${b}
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        detail: { source_id: a, target_id: b, moved_count: 3 },
        ip: IP,
      });
    },
  );

  it("re-points every gown's silhouette and accepts spec/api's into_id", async () => {
    const a = await make("silhouettes");
    const b = await make("silhouettes");
    const moved = [await gown(a), await gown(a)];

    const res = await merge("silhouettes", a, { into_id: b });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moved_count: 2 });
    const rows = await sql`SELECT silhouette_id FROM gowns WHERE id = ANY(${moved})`;
    expect(rows.every((r) => r.silhouette_id === b)).toBe(true);
    expect(await sql`SELECT 1 FROM silhouettes WHERE id = ${a}`).toHaveLength(0);
  });

  it("refuses a merge into itself with 422 and changes nothing", async () => {
    const a = await make("materials");
    const res = await merge("materials", a, { target_id: a });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(await sql`SELECT 1 FROM materials WHERE id = ${a}`).toHaveLength(1);
  });

  it("answers an unknown or cross-type id with 404 and changes nothing", async () => {
    const a = await make("materials");
    const collection = await make("collections");
    expect((await merge("materials", a, { target_id: randomUUID() })).status).toBe(404);
    expect((await merge("materials", randomUUID(), { target_id: a })).status).toBe(404);
    expect((await merge("materials", a, { target_id: collection })).status).toBe(404);
    expect(await sql`SELECT 1 FROM materials WHERE id = ${a}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM collections WHERE id = ${collection}`).toHaveLength(1);
  });

  it("answers a body with no target with 422", async () => {
    const a = await make("materials");
    expect((await merge("materials", a, {})).status).toBe(422);
  });

  it("refuses a merge without the CSRF token, or with no session", async () => {
    const a = await make("collections");
    const b = await make("collections");
    expect((await merge("collections", a, { target_id: b }, false)).status).toBe(403);
    const anon = await collectionMerge.POST(
      new NextRequest(`http://localhost:3000/api/admin/collections/${a}/merge`, {
        method: "POST",
        headers: { ...csrfHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ target_id: b }),
      }),
      params(a),
    );
    expect(anon.status).toBe(401);
    expect(await sql`SELECT 1 FROM collections WHERE id = ${a}`).toHaveLength(1);
  });

  it("lets one of two concurrent merges of the same pair win cleanly", async () => {
    const sil = await make("silhouettes");
    const a = await make("collections");
    const b = await make("collections");
    await gown(sil, [["collections", a]]);
    const statuses = (
      await Promise.all([
        merge("collections", a, { target_id: b }),
        merge("collections", a, { target_id: b }),
      ])
    )
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 404]);
    expect(await sql`SELECT 1 FROM gown_collections WHERE collection_id = ${b}`).toHaveLength(1);
  });
});
