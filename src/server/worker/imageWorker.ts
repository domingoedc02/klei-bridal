import "server-only";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { env } from "@/config/env";
import { db } from "@/server/db/client";
import { gownImages, imageJobs } from "@/server/db/schema";
import { originalsRoot } from "@/server/media/contentAddress";
import { generateSocialCrop } from "@/server/media/socialCrop";
import { generateVariants, variantsRoot, type DerivativeManifest } from "@/server/media/variants";

const MAX_ATTEMPTS = 3;
const STALE_AFTER_MS = 15 * 60_000;
const POLL_MS = 2_000;

type ClaimedJob = { id: string; gown_image_id: string; attempts: number; original_path: string };

/** Atomically claims one job, including a crashed worker's stale processing row. */
async function claimJob(): Promise<ClaimedJob | undefined> {
  const stale = new Date(Date.now() - STALE_AFTER_MS);
  const rows = await db.execute<ClaimedJob>(sql`
    WITH candidate AS (
      SELECT ij.id
      FROM image_jobs ij
      WHERE (
        ij.status = 'pending'
        OR (ij.status = 'processing' AND ij.updated_at < ${stale.toISOString()})
      )
      AND ij.attempts < ${MAX_ATTEMPTS}
      ORDER BY ij.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE image_jobs ij
    SET status = 'processing', attempts = ij.attempts + 1, updated_at = now(), last_error = NULL
    FROM candidate c
    JOIN gown_images gi ON gi.id = (SELECT gown_image_id FROM image_jobs WHERE id = c.id)
    WHERE ij.id = c.id
    RETURNING ij.id, ij.gown_image_id, ij.attempts, (SELECT original_path FROM gown_images WHERE id = ij.gown_image_id)
  `);
  return rows[0];
}

async function processJob(job: ClaimedJob) {
  const absolute = join(originalsRoot(), job.original_path);
  const generated = await generateVariants(absolute, job.original_path);
  const social = await generateSocialCrop(absolute, job.original_path);
  const manifest = { ...generated.manifest, social: { jpeg: social } } as DerivativeManifest;

  await db
    .update(gownImages)
    .set({ derivatives: manifest, lqip: generated.lqip })
    .where(sql`${gownImages.id} = ${job.gown_image_id}`);
  await db
    .update(imageJobs)
    .set({ status: "done", updatedAt: new Date(), lastError: null })
    .where(sql`${imageJobs.id} = ${job.id}`);
}

async function failJob(job: ClaimedJob, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await db
    .update(imageJobs)
    .set({ status, lastError: message.slice(0, 2_000), updatedAt: new Date() })
    .where(sql`${imageJobs.id} = ${job.id}`);
}

/** Process available work once; useful for deploy smoke tests and integration tests. */
export async function processImageJobs(limit = env.IMAGE_WORKER_CONCURRENCY) {
  const jobs: ClaimedJob[] = [];
  for (let i = 0; i < limit; i++) {
    const job = await claimJob();
    if (!job) break;
    jobs.push(job);
  }
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await processJob(job);
      } catch (error) {
        await failJob(job, error);
      }
    }),
  );
  return jobs.length;
}

let started = false;
/** Start bounded polling. Timer is unref'd so tests and one-shot scripts can exit. */
export function startImageWorker() {
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    void processImageJobs().catch((error) => console.error("image worker:", error));
  }, POLL_MS);
  timer.unref();
  void processImageJobs().catch((error) => console.error("image worker:", error));
}

export { MAX_ATTEMPTS, STALE_AFTER_MS, variantsRoot };
