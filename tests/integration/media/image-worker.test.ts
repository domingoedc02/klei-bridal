import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";
import { originalPath, originalsRoot, storeOriginal } from "@/server/media/contentAddress";
import { generateVariants } from "@/server/media/variants";
import { MAX_ATTEMPTS, processImageJobs } from "@/server/worker/imageWorker";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const staffId = randomUUID();
const gownIds: string[] = [];
const imageIds: string[] = [];
const tempRoot = join("/tmp", `kbs-image-worker-${process.pid}`);

async function makeGown() {
  const id = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${id}, ${`worker-${id}`}, 'Worker gown', 'draft', ${staffId}, ${staffId})
  `;
  gownIds.push(id);
  return id;
}

async function addImage(gownId: string, path: string, width = 80, height = 60) {
  const id = randomUUID();
  await sql`
    INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height, uploaded_by)
    VALUES (${id}, ${gownId}, 0, true, ${path}, ${width}, ${height}, ${staffId})
  `;
  await sql`INSERT INTO image_jobs (id, gown_image_id) VALUES (${randomUUID()}, ${id})`;
  imageIds.push(id);
  return id;
}

beforeAll(async () => {
  await mkdir(tempRoot, { recursive: true });
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash)
    VALUES (${staffId}, 'Worker Test', ${`worker-${staffId}@kleibridal.test`}, 'not-used')
  `;
});

afterAll(async () => {
  await sql`DELETE FROM gowns WHERE id = ANY(${gownIds})`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("image worker (KBS-13-2)", () => {
  it("generates every manifest format, LQIP, social crop, and reuses shared originals", async () => {
    const source = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#b45" },
    })
      .jpeg()
      .toBuffer();
    const relative = await storeOriginal(source, "jpg");
    const a = await makeGown();
    const b = await makeGown();
    await addImage(a, relative);
    await addImage(b, relative);

    expect(await processImageJobs(2)).toBe(2);
    const rows =
      await sql`SELECT derivatives, lqip FROM gown_images WHERE id = ANY(${imageIds}) ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.derivatives).toEqual(rows[1]!.derivatives);
    expect(rows[0]!.lqip).toMatch(/^data:image\/webp;base64,/);
    for (const width of [320, 480, 768, 1024, 1440, 2048]) {
      expect(rows[0]!.derivatives[String(width)]).toEqual({
        avif: expect.any(String),
        webp: expect.any(String),
        jpeg: expect.any(String),
      });
    }
    expect(rows[0]!.derivatives.social.jpeg).toMatch(/-social-1200x630\.jpg$/);
    expect(
      await sql`SELECT status FROM image_jobs WHERE gown_image_id = ANY(${imageIds}) ORDER BY gown_image_id`,
    ).toEqual([{ status: "done" }, { status: "done" }]);

    const derivative = join(process.env.IMAGE_CACHE_PATH!, rows[0]!.derivatives["2048"].avif);
    const first = await stat(derivative);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await generateVariants(join(originalsRoot(), relative), relative);
    expect((await stat(derivative)).mtimeMs).toBe(first.mtimeMs);
  });

  it("retries, then records a terminal failure for corrupt originals", async () => {
    const gown = await makeGown();
    const relative = originalPath(Buffer.from(`corrupt-${randomUUID()}`), "jpg");
    await mkdir(join(originalsRoot(), relative, ".."), { recursive: true });
    await writeFile(join(originalsRoot(), relative), "not an image");
    const image = await addImage(gown, relative);

    for (let i = 0; i < MAX_ATTEMPTS; i++) await processImageJobs(1);
    const [job] =
      await sql`SELECT status, attempts, last_error FROM image_jobs WHERE gown_image_id = ${image}`;
    expect(job).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(job!.last_error).toEqual(expect.any(String));
  });

  it("reclaims stale processing jobs", async () => {
    const source = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#456" },
    })
      .jpeg()
      .toBuffer();
    const relative = await storeOriginal(source, "jpg");
    const gown = await makeGown();
    const image = await addImage(gown, relative);
    await sql`UPDATE image_jobs SET status = 'processing', updated_at = now() - interval '1 hour' WHERE gown_image_id = ${image}`;
    expect(await processImageJobs(1)).toBe(1);
    const [job] = await sql`SELECT status FROM image_jobs WHERE gown_image_id = ${image}`;
    expect(job).toEqual({ status: "done" });
  });
});
