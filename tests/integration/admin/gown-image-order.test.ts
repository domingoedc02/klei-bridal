import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PATCH as reorder } from "../../../app/api/admin/gowns/[id]/images/reorder/route";
import { POST as hero } from "../../../app/api/admin/gowns/[id]/images/[imageId]/hero/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { csrfHeaders } from "../csrf-headers";

/** KBS-21-3: persisted order and a single hero, through the real routes and Postgres. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
let staffId: string;
let session: string;
const gownIds: string[] = [];

/** A gown with `n` images at sort_order 0..n-1, the first one hero. */
async function gownWith(n: number) {
  const gown = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${gown}, ${`order-${gown}`}, 'Order gown', 'draft', ${staffId}, ${staffId})
  `;
  gownIds.push(gown);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await sql`
      INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (${id}, ${gown}, ${i}, ${i === 0}, ${`t/${id}.jpg`}, 10, 10)
    `;
    ids.push(id);
  }
  return { gown, ids };
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...csrfHeaders(`${SESSION_COOKIE}=${session}`),
      "x-real-ip": "203.0.113.23",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const doReorder = (gown: string, order: string[]) =>
  reorder(req(`/api/admin/gowns/${gown}/images/reorder`, "PATCH", { order }), {
    params: Promise.resolve({ id: gown }),
  } as never);
const doHero = (gown: string, imageId: string) =>
  hero(req(`/api/admin/gowns/${gown}/images/${imageId}/hero`, "POST"), {
    params: Promise.resolve({ id: gown, imageId }),
  } as never);

const rows = (gown: string) => sql<{ id: string; sort_order: number; is_hero: boolean }[]>`
  SELECT id, sort_order, is_hero FROM gown_images WHERE gown_id = ${gown} ORDER BY sort_order`;

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Order Test', ${`order-${staffId}@kleibridal.test`}, 'not-used', true)
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

describe("reorder", () => {
  it("persists a full reversal (crosses the unique index) and audits it", async () => {
    const { gown, ids } = await gownWith(4);
    const order = [...ids].reverse();
    const res = await doReorder(gown, order);
    expect(res.status).toBe(200);
    expect((await res.json()).images.map((i: { id: string }) => i.id)).toEqual(order);
    expect((await rows(gown)).map((r) => [r.id, r.sort_order])).toEqual(
      order.map((id, i) => [id, i]),
    );
    const audit =
      await sql`SELECT detail FROM audit_log WHERE entity_id = ${gown} AND action = 'gown.image_reorder'`;
    expect(audit).toEqual([{ detail: { order } }]);
  });

  it("422s a partial, duplicated or foreign id list and moves nothing", async () => {
    const { gown, ids } = await gownWith(3);
    const { ids: foreign } = await gownWith(1);
    for (const bad of [
      ids.slice(0, 2),
      [ids[0]!, ids[0]!, ids[1]!],
      [ids[0]!, ids[1]!, foreign[0]!],
    ]) {
      const res = await doReorder(gown, bad);
      expect(res.status).toBe(422);
      expect((await res.json()).error.fields.order).toMatch(
        /every photo of this gown exactly once/,
      );
    }
    expect((await rows(gown)).map((r) => r.id)).toEqual(ids);
  });

  it("404s an unknown gown", async () => {
    expect((await doReorder(randomUUID(), [randomUUID()])).status).toBe(404);
  });
});

describe("hero", () => {
  it("moves the hero in one step, keeps exactly one, audits old and new", async () => {
    const { gown, ids } = await gownWith(3);
    const res = await doHero(gown, ids[2]!);
    expect(res.status).toBe(200);
    expect((await rows(gown)).filter((r) => r.is_hero).map((r) => r.id)).toEqual([ids[2]]);
    const audit =
      await sql`SELECT detail FROM audit_log WHERE entity_id = ${gown} AND action = 'gown.image_hero'`;
    expect(audit).toEqual([{ detail: { image_id: ids[2], previous_image_id: ids[0] } }]);
  });

  it("is a no-op on the current hero; 404s another gown's photo", async () => {
    const { gown, ids } = await gownWith(2);
    const { gown: other } = await gownWith(1);
    expect((await doHero(gown, ids[0]!)).status).toBe(200);
    expect(await sql`SELECT 1 FROM audit_log WHERE entity_id = ${gown}`).toHaveLength(0);
    expect((await doHero(other, ids[1]!)).status).toBe(404);
  });

  it("two concurrent hero changes leave exactly one hero, no 409", async () => {
    const { gown, ids } = await gownWith(3);
    const results = await Promise.all([doHero(gown, ids[1]!), doHero(gown, ids[2]!)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await rows(gown)).filter((r) => r.is_hero)).toHaveLength(1);
  });
});
