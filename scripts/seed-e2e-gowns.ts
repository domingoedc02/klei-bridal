import postgres from "postgres";
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
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600"><rect width="1200" height="1600" fill="#f4f1eb"/><path d="M600 180 430 560 260 1450h680L770 560Z" fill="#d9c7b8"/><circle cx="600" cy="130" r="70" fill="#c9ad99"/></svg>`,
);

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
      const images = await sql<{ id: string }[]>`
        SELECT id FROM gown_images WHERE gown_id = ${gownId} ORDER BY sort_order LIMIT 1
      `;
      const imageId = images[0]?.id ?? generateId();
      if (!images[0]) {
        await sql`
          INSERT INTO gown_images
            (id, gown_id, sort_order, is_hero, alt_text, original_path, derivatives, lqip, width, height)
          VALUES
            (${imageId}, ${gownId}, 0, true, ${"E2E gown fixture"}, ${originalPath}, ${sql.json(derivatives)}, ${generated.lqip}, 1200, 1600)
        `;
      } else {
        await sql`
          UPDATE gown_images
          SET original_path = ${originalPath}, derivatives = ${sql.json(derivatives)}, lqip = ${generated.lqip}, is_hero = true
          WHERE id = ${imageId}
        `;
      }
      await sql`
        UPDATE gowns
        SET status = 'published', is_in_stock = ${gown.isInStock}, hero_image_id = ${imageId}
        WHERE id = ${gownId}
      `;
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error("E2E gown seed failed:", error);
  process.exitCode = 1;
});
