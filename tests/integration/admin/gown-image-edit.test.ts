import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DELETE as del,
  PATCH as patch,
} from "../../../app/api/admin/gowns/[id]/images/[imageId]/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { originalsRoot } from "@/server/media/contentAddress";
import { csrfHeaders } from "../csrf-headers";

/** KBS-21-4: alt text edit and image delete, through the real routes and Postgres. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
let staffId: string;
let session: string;
const gownIds: string[] = [];

/** A gown with `n` images at sort_order 0..n-1, the first one hero, each with a real original file. */
async function gownWith(n: number, status = "draft") {
  const gown = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${gown}, ${`edit-${gown}`}, 'Edit gown', ${status}, ${staffId}, ${staffId})
  `;
  gownIds.push(gown);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const path = fileOf(id);
    await mkdir(join(originalsRoot(), path, ".."), { recursive: true });
    await writeFile(join(originalsRoot(), path), "x");
    await sql`
      INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (${id}, ${gown}, ${i}, ${i === 0}, ${path}, 10, 10)
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
      "x-real-ip": "203.0.113.24",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const url = (gown: string, imageId: string) => `/api/admin/gowns/${gown}/images/${imageId}`;
const ctx = (id: string, imageId: string) =>
  ({ params: Promise.resolve({ id, imageId }) }) as never;
const doPatch = (gown: string, imageId: string, body: unknown) =>
  patch(req(url(gown, imageId), "PATCH", body), ctx(gown, imageId));
const doDelete = (gown: string, imageId: string) =>
  del(req(url(gown, imageId), "DELETE"), ctx(gown, imageId));
const rows = (gown: string) => sql<{ id: string; is_hero: boolean }[]>`
  SELECT id, is_hero FROM gown_images WHERE gown_id = ${gown} ORDER BY sort_order`;
const audits = (action: string, gown: string) =>
  sql`SELECT detail FROM audit_log WHERE action = ${action} AND entity_id = ${gown}`;
/** Content-addressed shape (aa/bb/<sha256>.jpg), as storeOriginal names files. */
function fileOf(id: string) {
  const h = createHash("sha256").update(id).digest("hex");
  return `${h.slice(0, 2)}/${h.slice(2, 4)}/${h}.jpg`;
}
const exists = (id: string) =>
  access(join(originalsRoot(), fileOf(id))).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Edit Test', ${`edit-${staffId}@kleibridal.test`}, 'not-used', true)
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

describe("PATCH /api/admin/gowns/:id/images/:imageId", () => {
  it("sets trimmed alt text and audits it", async () => {
    const { gown, ids } = await gownWith(1);
    const res = await doPatch(gown, ids[0]!, { alt: "  Lace back detail " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: ids[0], alt_text: "Lace back detail" });
    expect(await audits("gown_image.alt_update", gown)).toHaveLength(1);

    expect((await doPatch(gown, ids[0]!, { alt: "" })).status).toBe(200);
  });

  it("rejects alt over 250 characters with 422 fields.alt, and changes nothing", async () => {
    const { gown, ids } = await gownWith(1);
    const res = await doPatch(gown, ids[0]!, { alt: "a".repeat(251) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields).toHaveProperty("alt");
    const [row] = await sql`SELECT alt_text FROM gown_images WHERE id = ${ids[0]!}`;
    expect(row!.alt_text).toBeNull();
  });

  it("404s for an image on another gown", async () => {
    const a = await gownWith(1);
    const b = await gownWith(1);
    expect((await doPatch(a.gown, b.ids[0]!, { alt: "x" })).status).toBe(404);
    expect((await doDelete(a.gown, b.ids[0]!)).status).toBe(404);
    expect(await rows(b.gown)).toHaveLength(1);
  });
});

describe("DELETE /api/admin/gowns/:id/images/:imageId", () => {
  it("deletes one image of three, removes its original after commit, and audits", async () => {
    const { gown, ids } = await gownWith(3);
    const res = await doDelete(gown, ids[1]!);
    expect(res.status).toBe(204);
    expect((await rows(gown)).map((r) => r.id)).toEqual([ids[0], ids[2]]);
    expect(await exists(ids[1]!)).toBe(false);
    expect(await exists(ids[0]!)).toBe(true);
    expect(await sql`SELECT 1 FROM image_jobs WHERE gown_image_id = ${ids[1]!}`).toHaveLength(0);
    expect(await audits("gown_image.delete", gown)).toHaveLength(1);
  });

  it("promotes the lowest remaining sort_order when the hero is deleted", async () => {
    const { gown, ids } = await gownWith(3);
    await sql`UPDATE gown_images SET sort_order = 5 WHERE id = ${ids[1]!}`;
    expect((await doDelete(gown, ids[0]!)).status).toBe(204);
    const left = await rows(gown);
    expect(left.filter((r) => r.is_hero).map((r) => r.id)).toEqual([ids[2]]);
    const [audit] = await audits("gown_image.delete", gown);
    expect(audit!.detail).toMatchObject({ image_id: ids[0], new_hero_image_id: ids[2] });
  });

  it("409s when the hero of a published gown is deleted, and changes nothing", async () => {
    const { gown, ids } = await gownWith(2, "published");
    const res = await doDelete(gown, ids[0]!);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("Choose another hero photo first.");
    const left = await rows(gown);
    expect(left.map((r) => [r.id, r.is_hero])).toEqual([
      [ids[0], true],
      [ids[1], false],
    ]);
    expect(await exists(ids[0]!)).toBe(true);
    expect(await audits("gown_image.delete", gown)).toHaveLength(0);
  });

  it("409s for the last image on a published gown and keeps it", async () => {
    const { gown, ids } = await gownWith(1, "published");
    const res = await doDelete(gown, ids[0]!);
    expect(res.status).toBe(409);
    expect(await rows(gown)).toHaveLength(1);
    expect(await exists(ids[0]!)).toBe(true);
    expect(await audits("gown_image.delete", gown)).toHaveLength(0);
  });

  it("allows deleting the last image of a draft gown", async () => {
    const { gown, ids } = await gownWith(1);
    expect((await doDelete(gown, ids[0]!)).status).toBe(204);
    expect(await rows(gown)).toHaveLength(0);
  });

  it("keeps a file another image still references", async () => {
    const { gown, ids } = await gownWith(2);
    await sql`UPDATE gown_images SET original_path = ${fileOf(ids[0]!)} WHERE id = ${ids[1]!}`;
    expect((await doDelete(gown, ids[0]!)).status).toBe(204);
    expect(await exists(ids[0]!)).toBe(true);
  });
});
