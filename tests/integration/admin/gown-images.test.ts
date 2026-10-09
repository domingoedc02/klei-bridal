import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { NextRequest } from "next/server";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as upload } from "../../../app/api/admin/gowns/[id]/images/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { originalsRoot } from "@/server/media/contentAddress";
import { csrfHeaders } from "../csrf-headers";

/**
 * KBS-13-1 through the real route, Postgres 17 and the media root from
 * env.ts: valid upload, the audit row, and the hostile files — renamed and
 * polyglot, oversize, decompression-bomb header, traversal filename, the
 * 11th photo, GPS EXIF.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

let staffId: string;
let cookie: string;
const gownIds: string[] = [];

async function makeGown() {
  const id = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${id}, ${`img-${id}`}, 'Image gown', 'draft', ${staffId}, ${staffId})
  `;
  gownIds.push(id);
  return id;
}

function photo(width = 64, height = 48, colour = "#b45") {
  return sharp({ create: { width, height, channels: 3, background: colour } })
    .jpeg()
    .toBuffer();
}

type Part = { data: Buffer | string; name?: string; type?: string };

function post(gownId: string, parts: Part[], opts: { csrf?: boolean; session?: boolean } = {}) {
  const form = new FormData();
  for (const p of parts) {
    form.append(
      "files",
      new File(
        [typeof p.data === "string" ? p.data : new Uint8Array(p.data)],
        p.name ?? "photo.jpg",
        { type: p.type ?? "image/jpeg" },
      ),
    );
  }
  const session = opts.session === false ? "" : `${SESSION_COOKIE}=${cookie}`;
  const req = new NextRequest(`http://localhost:3000/api/admin/gowns/${gownId}/images`, {
    method: "POST",
    headers: {
      ...(opts.csrf === false ? { cookie: session } : csrfHeaders(session || undefined)),
      "x-real-ip": "203.0.113.13",
    },
    body: form,
  });
  return upload(req, { params: Promise.resolve({ id: gownId }) } as never);
}

/** A ~100-byte PNG whose IHDR claims 50000×50000 (2.5 GP). */
function bombPng() {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(50_000, 0);
  ihdr.writeUInt32BE(50_000, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(0)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function imagesOf(gownId: string) {
  return sql<{ id: string; original_path: string; sort_order: number; is_hero: boolean }[]>`
    SELECT id, original_path, sort_order, is_hero FROM gown_images
    WHERE gown_id = ${gownId} ORDER BY sort_order
  `;
}

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Image Test', ${`img-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  cookie = (await createSession(db, { staffUserId: staffId, ip: null, userAgent: null })).token;
});

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds})`;
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${staffId}`;
  await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("auth and CSRF", () => {
  it("refuses no session (401) and no CSRF token (403), writing nothing", async () => {
    const gown = await makeGown();
    expect((await post(gown, [{ data: await photo() }], { session: false })).status).toBe(401);
    expect((await post(gown, [{ data: await photo() }], { csrf: false })).status).toBe(403);
    expect(await imagesOf(gown)).toHaveLength(0);
  });

  it("404s an unknown gown", async () => {
    expect((await post(randomUUID(), [{ data: await photo() }])).status).toBe(404);
  });
});

describe("a valid upload", () => {
  it("201: rows, pending jobs, content-addressed originals, one audit row", async () => {
    const gown = await makeGown();
    const res = await post(gown, [
      { data: await photo(64, 48, "#a11") },
      { data: await photo(48, 64, "#1a1") },
    ]);
    expect(res.status).toBe(201);
    const { images } = await res.json();
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ sort_order: 0, is_hero: true, width: 64, height: 48 });
    expect(images[1]).toMatchObject({ sort_order: 1, is_hero: false, width: 48, height: 64 });

    const rows = await imagesOf(gown);
    for (const row of rows) {
      expect(row.original_path).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.jpg$/);
      expect(existsSync(join(originalsRoot(), row.original_path))).toBe(true);
    }
    const jobs = await sql`
      SELECT status FROM image_jobs WHERE gown_image_id = ANY(${rows.map((r) => r.id)})
    `;
    expect(jobs.map((j) => j.status)).toEqual(["pending", "pending"]);
    const audit = await sql`
      SELECT action, entity_type, detail, host(ip) AS ip FROM audit_log
      WHERE actor_user_id = ${staffId} AND entity_id = ${gown}
    `;
    expect(audit).toEqual([
      {
        action: "gown.image_upload",
        entity_type: "gown",
        detail: { image_ids: rows.map((r) => r.id), count: 2 },
        ip: "203.0.113.13",
      },
    ]);
  });

  it("continues sort order and keeps the first hero on a second upload", async () => {
    const gown = await makeGown();
    await post(gown, [{ data: await photo(10, 10, "#123") }]);
    const res = await post(gown, [{ data: await photo(10, 10, "#456") }]);
    expect((await res.json()).images[0]).toMatchObject({ sort_order: 1, is_hero: false });
  });

  it("strips EXIF and GPS from the stored original", async () => {
    const gown = await makeGown();
    const withGps = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#fff" },
    })
      .jpeg()
      .withExif({
        IFD0: { Make: "Studio Cam" },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "14/1 35/1 0/1" },
      })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    expect((await post(gown, [{ data: withGps }])).status).toBe(201);
    const [row] = await imagesOf(gown);
    const stored = readFileSync(join(originalsRoot(), row!.original_path));
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from("Studio Cam"))).toBe(false);
  });
});

describe("hostile files", () => {
  it("422s an HTML file renamed .jpg and sent as image/jpeg", async () => {
    const gown = await makeGown();
    const res = await post(gown, [{ data: "<html><script>alert(1)</script></html>" }]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.files).toMatch(/JPEG, PNG or WebP/);
    expect(await imagesOf(gown)).toHaveLength(0);
  });

  it("422s a polyglot: JPEG magic bytes followed by script, not a photo", async () => {
    const gown = await makeGown();
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("<script>")]);
    expect((await post(gown, [{ data: fake }])).status).toBe(422);
  });

  it("stores only decoded pixels: a payload appended after a real JPEG is dropped", async () => {
    const gown = await makeGown();
    const tail = Buffer.from("<?php system($_GET['c']); ?>");
    const polyglot = Buffer.concat([await photo(), tail]);
    expect((await post(gown, [{ data: polyglot }])).status).toBe(201);
    const [row] = await imagesOf(gown);
    expect(readFileSync(join(originalsRoot(), row!.original_path)).includes(tail)).toBe(false);
  });

  it("422s a truncated photo after the decode-validate", async () => {
    const gown = await makeGown();
    const whole = await photo(200, 200);
    expect((await post(gown, [{ data: whole.subarray(0, 300) }])).status).toBe(422);
  });

  it("422s a decompression bomb from its header, without decoding", async () => {
    const gown = await makeGown();
    const t0 = performance.now();
    const res = await post(gown, [{ data: bombPng(), name: "bomb.png", type: "image/png" }]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.files).toMatch(/40 megapixels/);
    // A real 2.5 GP decode takes seconds and gigabytes; a header read is ms.
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("413s a file over IMAGE_MAX_UPLOAD_BYTES", async () => {
    const gown = await makeGown();
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 0xff);
    expect((await post(gown, [{ data: big }])).status).toBe(413);
  });

  it("ignores a traversal filename: the stored path is server-chosen, under the root", async () => {
    const gown = await makeGown();
    const res = await post(gown, [{ data: await photo(12, 12, "#789"), name: "../../etc/passwd" }]);
    expect(res.status).toBe(201);
    const [row] = await imagesOf(gown);
    expect(row!.original_path).not.toContain("..");
    expect(row!.original_path).not.toContain("passwd");
    expect(resolve(originalsRoot(), row!.original_path).startsWith(originalsRoot() + "/")).toBe(
      true,
    );
  });

  it("refuses the 11th photo for a gown, naming the limit", async () => {
    const gown = await makeGown();
    const ten = await Promise.all(
      Array.from({ length: 10 }, (_, i) => photo(8, 8, `#${(i + 1).toString(16)}00`)),
    );
    expect(
      (
        await post(
          gown,
          ten.map((data) => ({ data })),
        )
      ).status,
    ).toBe(201);
    const res = await post(gown, [{ data: await photo(8, 8, "#0f0") }]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.fields.files).toMatch(/at most 10/);
    expect(await imagesOf(gown)).toHaveLength(10);
  });

  it("413s eleven files in one request", async () => {
    const gown = await makeGown();
    const data = await photo();
    const res = await post(
      gown,
      Array.from({ length: 11 }, () => ({ data })),
    );
    expect(res.status).toBe(413);
  });
});
