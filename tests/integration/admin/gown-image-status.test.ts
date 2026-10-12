import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as list, POST as upload } from "../../../app/api/admin/gowns/[id]/images/route";
import { POST as retry } from "../../../app/api/admin/gowns/[id]/images/[imageId]/retry/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { MAX_ATTEMPTS, processImageJobs } from "@/server/worker/imageWorker";
import { csrfHeaders } from "../csrf-headers";

/**
 * KBS-21-2 through the real routes and worker: upload answers before any
 * encode, status moves pending → ready / failed, a failed photo retries,
 * and one bad file in a per-file batch costs only itself.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
let staffId: string;
let session: string;
const gownIds: string[] = [];

async function makeGown() {
  const id = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${id}, ${`status-${id}`}, 'Status gown', 'draft', ${staffId}, ${staffId})
  `;
  gownIds.push(id);
  return id;
}

const photo = (colour: string) =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: colour } })
    .jpeg()
    .toBuffer();

function req(url: string, init: { method: string; body?: FormData; csrf?: boolean }) {
  const cookie = `${SESSION_COOKIE}=${session}`;
  return new NextRequest(`http://localhost:3000${url}`, {
    method: init.method,
    headers: {
      ...(init.csrf === false ? { cookie } : csrfHeaders(cookie)),
      "x-real-ip": "203.0.113.21",
    },
    ...(init.body ? { body: init.body } : {}),
  });
}

async function uploadOne(gownId: string, data: Buffer | string) {
  const form = new FormData();
  form.append("files", new File([typeof data === "string" ? data : new Uint8Array(data)], "p.jpg"));
  return upload(req(`/api/admin/gowns/${gownId}/images`, { method: "POST", body: form }), {
    params: Promise.resolve({ id: gownId }),
  } as never);
}

async function statuses(gownId: string) {
  const res = await list(req(`/api/admin/gowns/${gownId}/images`, { method: "GET" }), {
    params: Promise.resolve({ id: gownId }),
  } as never);
  expect(res.status).toBe(200);
  return ((await res.json()).images as { id: string; status: string }[]).map((i) => i.status);
}

function retryReq(gownId: string, imageId: string) {
  return retry(req(`/api/admin/gowns/${gownId}/images/${imageId}/retry`, { method: "POST" }), {
    params: Promise.resolve({ id: gownId, imageId }),
  } as never);
}

/** Drain the queue, including our jobs, however many other tests left pending. */
async function drain() {
  while ((await processImageJobs(4)) > 0);
}

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Status Test', ${`status-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  session = (await createSession(db, { staffUserId: staffId, ip: null, userAgent: null })).token;
});

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds})`;
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${staffId}`;
  await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("encode status (KBS-21-2)", () => {
  it("upload answers before encoding: rows pending, no derivatives yet; then ready", async () => {
    const gown = await makeGown();
    const res = await uploadOne(gown, await photo("#a1b2c3"));
    expect(res.status).toBe(201);
    expect((await res.json()).images[0].status).toBe("pending");
    const [row] = await sql`SELECT derivatives FROM gown_images WHERE gown_id = ${gown}`;
    expect(row!.derivatives).toEqual({}); // nothing encoded on the request path
    expect(await statuses(gown)).toEqual(["pending"]);
    await drain();
    expect(await statuses(gown)).toEqual(["ready"]);
  });

  it("per-file batch: a bad third file fails alone, the others persist", async () => {
    const gown = await makeGown();
    const results = [];
    for (const data of [
      await photo("#111"),
      await photo("#222"),
      "not a photo",
      await photo("#444"),
    ]) {
      results.push((await uploadOne(gown, data)).status);
    }
    expect(results).toEqual([201, 201, 422, 201]);
    expect(await statuses(gown)).toHaveLength(3);
  });

  it("a failed encode shows failed, retries to pending, and is audited", async () => {
    const gown = await makeGown();
    const { images } = await (await uploadOne(gown, await photo("#c0ffee"))).json();
    const id = images[0].id as string;
    await sql`UPDATE image_jobs SET status = 'failed', attempts = ${MAX_ATTEMPTS},
      last_error = '/data/media/originals/secret' WHERE gown_image_id = ${id}`;

    const listed = await list(req(`/api/admin/gowns/${gown}/images`, { method: "GET" }), {
      params: Promise.resolve({ id: gown }),
    } as never);
    const text = await listed.text();
    expect(JSON.parse(text).images[0].status).toBe("failed");
    expect(text).not.toContain("/data/media"); // last_error stays server-side

    const res = await retryReq(gown, id);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
    const [job] =
      await sql`SELECT status, attempts, last_error FROM image_jobs WHERE gown_image_id = ${id}`;
    expect(job).toEqual({ status: "pending", attempts: 0, last_error: null });
    const audit = await sql`SELECT detail FROM audit_log
      WHERE entity_id = ${gown} AND action = 'gown.image_retry'`;
    expect(audit).toEqual([{ detail: { image_id: id } }]);

    await drain();
    expect(await statuses(gown)).toEqual(["ready"]);
  });

  it("409s a retry of a photo that has not failed, 404s another gown's photo", async () => {
    const gown = await makeGown();
    const other = await makeGown();
    const { images } = await (await uploadOne(gown, await photo("#abcdef"))).json();
    expect((await retryReq(gown, images[0].id)).status).toBe(409);
    expect((await retryReq(other, images[0].id)).status).toBe(404);
  });

  it("401s without a session, 403s a retry without CSRF, 404s an unknown gown", async () => {
    const gown = await makeGown();
    const anon = new NextRequest(`http://localhost:3000/api/admin/gowns/${gown}/images`);
    expect((await list(anon, { params: Promise.resolve({ id: gown }) } as never)).status).toBe(401);
    const id = randomUUID();
    const noCsrf = retry(
      req(`/api/admin/gowns/${gown}/images/${id}/retry`, { method: "POST", csrf: false }),
      {
        params: Promise.resolve({ id: gown, imageId: id }),
      } as never,
    );
    expect((await noCsrf).status).toBe(403);
    const missing = randomUUID();
    const res = await list(req(`/api/admin/gowns/${missing}/images`, { method: "GET" }), {
      params: Promise.resolve({ id: missing }),
    } as never);
    expect(res.status).toBe(404);
  });
});
