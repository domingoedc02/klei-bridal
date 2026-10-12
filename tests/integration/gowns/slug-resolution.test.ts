import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import GownDetailPage, { generateMetadata } from "../../../app/(public)/gowns/[slug]/page";
import { resolvePublishedGownSlug } from "@/server/services/gowns";

/** KBS-15-1: published-only resolution, old-slug 308, no draft image data in metadata. */

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const ids: string[] = [];

async function gown(status: "draft" | "published" | "archived") {
  const id = randomUUID();
  const slug = `kbs151-${id}`;
  ids.push(id);
  await sql`INSERT INTO gowns (id, slug, name, status) VALUES (${id}, ${slug}, 'Slug gown', ${status})`;
  await sql`
    INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, derivatives, width, height)
    VALUES (${randomUUID()}, ${id}, 0, true, ${`aa/bb/${id}.jpg`},
            ${sql.json({ social: { jpeg: `aa/bb/${id}-social-1200x630.jpg` } })}, 10, 10)`;
  return { id, slug };
}

async function redirectFrom(gownId: string) {
  const oldSlug = `kbs151-old-${randomUUID()}`;
  await sql`INSERT INTO gown_slug_redirects (old_slug, gown_id) VALUES (${oldSlug}, ${gownId})`;
  return oldSlug;
}

/** Next's redirect()/notFound() throw; the digest carries the status code. */
async function thrown(slug: string): Promise<string> {
  try {
    await GownDetailPage({ params: Promise.resolve({ slug }) });
  } catch (error) {
    return (error as { digest: string }).digest;
  }
  return "rendered";
}

afterAll(async () => {
  // Redirect rows cascade from gowns.
  if (ids.length) await sql`DELETE FROM gowns WHERE id = ANY(${ids}::uuid[])`;
  await sql.end();
});

describe("gown slug resolution (KBS-15-1)", () => {
  it("resolves a published slug to its gown", async () => {
    const { id, slug } = await gown("published");
    expect(await resolvePublishedGownSlug(slug)).toMatchObject({ kind: "canonical", gown: { id } });
  });

  it("an old slug 308s to the absolute canonical URL built from SITE_URL", async () => {
    const { id, slug } = await gown("published");
    const oldSlug = await redirectFrom(id);
    expect(await thrown(oldSlug)).toBe(
      `NEXT_REDIRECT;replace;${process.env.SITE_URL}/gowns/${slug};308;`,
    );
  });

  it("a current slug never consults gown_slug_redirects", async () => {
    const { id, slug } = await gown("published");
    // A stale redirect row naming the live slug must not shadow it.
    await sql`INSERT INTO gown_slug_redirects (old_slug, gown_id) VALUES (${slug}, ${id})`;
    expect(await resolvePublishedGownSlug(slug)).toMatchObject({ kind: "canonical" });
  });

  it("an unknown slug 404s, never redirects", async () => {
    expect(await thrown(`kbs151-none-${randomUUID()}`)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it.each(["draft", "archived"] as const)(
    "a %s gown, or an old slug pointing at one, 404s with empty metadata (no image hashes)",
    async (status) => {
      const { id, slug } = await gown(status);
      const oldSlug = await redirectFrom(id);
      for (const s of [slug, oldSlug]) {
        expect(await thrown(s)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
        const metadata = await generateMetadata({ params: Promise.resolve({ slug: s }) });
        expect(metadata).toEqual({});
        expect(JSON.stringify(metadata)).not.toContain(id);
      }
    },
  );

  it("published metadata carries the absolute social crop", async () => {
    const { id, slug } = await gown("published");
    const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({
        url: `${process.env.SITE_URL}/media/aa/bb/${id}-social-1200x630.jpg`,
      }),
    ]);
  });
});
