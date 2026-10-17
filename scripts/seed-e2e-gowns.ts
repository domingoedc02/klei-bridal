import postgres from "postgres";
import sharp from "sharp";
import { join } from "node:path";

import { env } from "@/config/env";
import { generateId } from "@/server/db/uuid";
import { storeOriginal } from "@/server/media/contentAddress";
import { generateSocialCrop } from "@/server/media/socialCrop";
import { generateVariants } from "@/server/media/variants";

const gowns = [
  { slug: "sample-in-stock-a-line", isInStock: true },
  { slug: "sample-made-to-order-mermaid", isInStock: false },
] as const;

const fixture = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048" viewBox="0 0 2048 2048"><rect width="2048" height="2048" fill="#f4f1eb"/><path d="M1024 230 730 720 410 1830h1228L1318 720Z" fill="#d9c7b8"/><circle cx="1024" cy="165" r="95" fill="#c9ad99"/></svg>`,
);

/**
 * KBS-12: a dense, high-frequency "lace" master (deterministic) so the zoom
 * byte budget is measured on hard-to-compress detail, not a flat SVG. It is
 * synthetic: real beadwork/Chantilly photography is measured separately and
 * escalated to decision/images if it breaks 600KB.
 */
async function laceMaster(): Promise<Buffer> {
  const size = 2048;
  const raw = Buffer.alloc(size * size * 3);
  let seed = 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const weave = Math.sin(x / 5) * Math.sin(y / 5) + Math.sin((x + y) / 9) * Math.cos((x - y) / 7);
      const v = Math.max(0, Math.min(255, 200 + weave * 30 + (seed / 4294967296 - 0.5) * 24));
      const i = (y * size + x) * 3;
      raw[i] = v;
      raw[i + 1] = v - 6;
      raw[i + 2] = v - 14;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Gowns with exactly 6 and 10 lace photographs (KBS-12 reachability + budget). */
async function seedZoomGowns(sql: postgres.Sql) {
  const lace = await laceMaster();
  const originalPath = await storeOriginal(lace, "jpg");
  const generated = await generateVariants(join(env.IMAGE_ORIGINALS_PATH, originalPath), originalPath);
  for (const [slug, count] of [
    ["e2e-zoom-six", 6],
    ["e2e-zoom-ten", 10],
  ] as const) {
    const [gown] = await sql<{ id: string }[]>`
      INSERT INTO gowns (id, slug, name, description, status)
      VALUES (${generateId()}, ${slug}, ${`Zoom ${count}`}, 'Lace fixture.', 'published')
      ON CONFLICT (slug) DO UPDATE SET status = 'published'
      RETURNING id`;
    const gownId = gown!.id;
    await sql`DELETE FROM gown_images WHERE gown_id = ${gownId}`;
    let heroId = "";
    for (let i = 0; i < count; i++) {
      const id = generateId();
      if (i === 0) heroId = id;
      await sql`
        INSERT INTO gown_images
          (id, gown_id, sort_order, is_hero, alt_text, original_path, derivatives, lqip, width, height)
        VALUES
          (${id}, ${gownId}, ${i}, ${i === 0}, null, ${originalPath}, ${sql.json(generated.manifest)}, ${generated.lqip}, 2048, 2048)`;
    }
    await sql`UPDATE gowns SET hero_image_id = ${heroId} WHERE id = ${gownId}`;
  }
}

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1 });
  try {
    const originalPath = await storeOriginal(fixture, "svg");
    const originalAbsolutePath = join(env.IMAGE_ORIGINALS_PATH, originalPath);
    const generated = await generateVariants(originalAbsolutePath, originalPath);
    const social = await generateSocialCrop(originalAbsolutePath, originalPath);
    const derivatives = { ...generated.manifest, social: { jpeg: social } };

    for (const gown of gowns) {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM gowns WHERE slug = ${gown.slug} LIMIT 1
      `;
      if (!rows[0]) throw new Error(`Seed gown missing: ${gown.slug}`);
      const gownId = rows[0].id;
      const images = await sql<{ id: string; sort_order: number }[]>`
        SELECT id, sort_order FROM gown_images WHERE gown_id = ${gownId} ORDER BY sort_order
      `;
      const imageId = images[0]?.id ?? generateId();
      if (!images[0]) {
        await sql`
          INSERT INTO gown_images
            (id, gown_id, sort_order, is_hero, alt_text, original_path, derivatives, lqip, width, height)
          VALUES
            (${imageId}, ${gownId}, 0, true, ${"E2E gown fixture hero"}, ${originalPath}, ${sql.json(derivatives)}, ${generated.lqip}, 2048, 2048)
        `;
      } else {
        await sql`
          UPDATE gown_images
          SET original_path = ${originalPath}, derivatives = ${sql.json(derivatives)}, lqip = ${generated.lqip}, is_hero = true, width = 2048, height = 2048
          WHERE id = ${imageId}
        `;
      }
      const detailImageId = images[1]?.id ?? generateId();
      await sql`
        INSERT INTO gown_images
          (id, gown_id, sort_order, is_hero, alt_text, original_path, derivatives, lqip, width, height)
        VALUES
          (${detailImageId}, ${gownId}, 1, false, ${"E2E gown fixture detail"}, ${originalPath}, ${sql.json(derivatives)}, ${generated.lqip}, 2048, 2048)
        ON CONFLICT (id) DO UPDATE SET
          original_path = EXCLUDED.original_path,
          derivatives = EXCLUDED.derivatives,
          lqip = EXCLUDED.lqip,
          width = 2048,
          height = 2048,
          is_hero = false
      `;
      await sql`
        UPDATE gowns
        SET
          name = ${gown.isInStock ? "Celestine" : "Sample — Made-to-order Mermaid"},
          price_status = ${gown.isInStock ? "priced" : "on_request"},
          price_minor = ${gown.isInStock ? 12500000 : null},
          currency = 'PHP',
          status = 'published',
          is_in_stock = ${gown.isInStock},
          hero_image_id = ${imageId}
        WHERE id = ${gownId}
      `;
    }
    await seedZoomGowns(sql);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error("E2E gown seed failed:", error);
  process.exitCode = 1;
});
