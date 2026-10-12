import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

// KBS-15-1 over real HTTP against the standalone server: the redirect status
// and Location a scraper sees, and the og: tags a no-JS bot gets in the HTML.

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const id = randomUUID();
const slug = `e2e-kbs151-${id}`;
const oldSlug = `e2e-kbs151-old-${id}`;

test.beforeAll(async () => {
  await sql`INSERT INTO gowns (id, slug, name, description, status)
    VALUES (${id}, ${slug}, 'E2E Slug Gown', 'Lace over silk.', 'published') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO gown_slug_redirects (old_slug, gown_id) VALUES (${oldSlug}, ${id})
    ON CONFLICT DO NOTHING`;
});

test.afterAll(async () => {
  await sql`DELETE FROM gowns WHERE id = ${id}`; // redirect row cascades
  await sql.end();
});

test("old slug 308s to the absolute canonical URL; unknown slug 404s", async ({
  request,
  baseURL,
}) => {
  const moved = await request.get(`/gowns/${oldSlug}`, { maxRedirects: 0 });
  expect(moved.status()).toBe(308);
  expect(moved.headers()["location"]).toBe(`${baseURL}/gowns/${slug}`);
  expect((await request.get(`/gowns/e2e-none-${id}`, { maxRedirects: 0 })).status()).toBe(404);
});

test("a link-preview bot gets the gown's og: tags in the HTML", async ({ request, baseURL }) => {
  const res = await request.get(`/gowns/${slug}`, {
    headers: { "user-agent": "facebookexternalhit/1.1" },
  });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<meta property="og:title" content="E2E Slug Gown"/>');
  expect(html).toContain(`<meta property="og:url" content="${baseURL}/gowns/${slug}"/>`);
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"/>');
});
