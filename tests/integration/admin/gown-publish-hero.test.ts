import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";
import { deleteGownImage, setGownHero } from "@/server/services/admin-gown-images";
import { publishAdminGown } from "@/server/services/admin-gowns";
import { PipelineError, type Principal } from "@/server/pipeline";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 2 },
);
const staffId = randomUUID();
const gownIds: string[] = [];
const imageIds: string[] = [];
let actor: Principal;

beforeAll(async () => {
  const email = `publish-hero-${staffId}@kleibridal.test`;
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Publish Hero Test', ${email}, 'not-used', true)
  `;
  actor = {
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
    staff: { id: staffId, name: "Publish Hero Test", email },
  };
});

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds}::uuid[])`;
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

async function gownWithHero(
  heroStatus: "pending" | "failed" | "done" | "no-job" | null,
  secondStatus?: "pending" | "failed" | "done",
) {
  const gownId = randomUUID();
  gownIds.push(gownId);
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${gownId}, ${`publish-hero-${gownId}`}, 'Publish hero test', 'draft', ${staffId}, ${staffId})
  `;
  const ids: string[] = [];
  for (const [index, status] of [heroStatus, secondStatus].entries()) {
    if (status === undefined || status === null) continue; // null: the gown has no image at all
    const imageId = randomUUID();
    ids.push(imageId);
    imageIds.push(imageId);
    await sql`
      INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
      VALUES (${imageId}, ${gownId}, ${index}, ${index === 0}, ${`publish-hero/${imageId}.jpg`}, 10, 10)
    `;
    if (status !== "no-job") {
      await sql`
        INSERT INTO image_jobs (id, gown_image_id, status)
        VALUES (${randomUUID()}, ${imageId}, ${status})
      `;
    }
  }
  return { gownId, imageIds: ids };
}

function errorOf(error: unknown) {
  return error instanceof PipelineError ? error : undefined;
}

async function publishError(gownId: string) {
  try {
    await publishAdminGown(gownId, actor, db);
    throw new Error("publish unexpectedly succeeded");
  } catch (error) {
    return errorOf(error);
  }
}

describe("publish ready-hero gate", () => {
  it.each([
    ["pending", "Choose a hero photo that has finished processing."],
    ["failed", "Choose a hero photo that has finished processing."],
  ] as const)("refuses %s hero with exact neutral field error", async (status, message) => {
    const { gownId } = await gownWithHero(status);
    const error = await publishError(gownId);
    expect(error).toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Check the highlighted fields.",
    });
    expect(error?.fields).toEqual({ images: message });
    expect(JSON.stringify(error)).not.toContain(gownId);
  });

  it("keeps no-image refusal contract", async () => {
    const { gownId } = await gownWithHero(null);
    const error = await publishError(gownId);
    expect(error).toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Check the highlighted fields.",
    });
    expect(error?.fields).toEqual({ images: "Add a gown image before publishing." });

    // A hero with no encode job at all is not ready either (KBS-117 gate).
    const noJob = await gownWithHero("no-job");
    expect((await publishError(noJob.gownId))?.fields).toEqual({
      images: "Choose a hero photo that has finished processing.",
    });
  });

  it("refuses ready non-hero when hero is still pending", async () => {
    const { gownId, imageIds: ids } = await gownWithHero("pending", "done");
    const error = await publishError(gownId);
    expect(error?.fields).toEqual({ images: "Choose a hero photo that has finished processing." });
    expect(ids).toHaveLength(2);
  });

  it("publishes ready hero and writes one audit row", async () => {
    const { gownId } = await gownWithHero("done");
    await publishAdminGown(gownId, actor, db);
    const [row] = await sql`SELECT status FROM gowns WHERE id = ${gownId}`;
    expect(row!.status).toBe("published");
    const audits =
      await sql`SELECT id FROM audit_log WHERE entity_id = ${gownId} AND action = 'gown.publish'`;
    expect(audits).toHaveLength(1);
  });

  it("guards published hero replacement and deletion", async () => {
    const { gownId, imageIds: ids } = await gownWithHero("done", "pending");
    await sql`UPDATE gowns SET status = 'published' WHERE id = ${gownId}`;
    await expect(setGownHero(gownId, ids[1]!, actor, null, db)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "This photo hasn't finished processing yet.",
    });
    await expect(deleteGownImage(gownId, ids[0]!, actor, null, db)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "Choose another hero photo first.",
    });
  });

  it("serializes publish and hero replacement on gown row", async () => {
    const { gownId, imageIds: ids } = await gownWithHero("pending", "done");
    const results = await Promise.allSettled([
      publishAdminGown(gownId, actor, db),
      setGownHero(gownId, ids[1]!, actor, null, db),
    ]);
    const [row] = await sql`
      SELECT g.status, i.is_hero, j.status AS job_status
      FROM gowns g
      JOIN gown_images i ON i.gown_id = g.id AND i.is_hero
      LEFT JOIN image_jobs j ON j.gown_image_id = i.id
      WHERE g.id = ${gownId}
    `;
    if (row!.status === "published") expect(row!.job_status).toBe("done");
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });
});
