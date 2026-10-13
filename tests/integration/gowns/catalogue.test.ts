import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import GownsPage from "../../../app/(public)/gowns/page";
import { listCatalogue } from "@/server/services/catalogue";
import { gownFilterQuerySchema } from "@/shared/schemas/gownFilters";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const gownIds: string[] = [];
const taxonomyIds: { table: "silhouettes" | "materials" | "collections"; id: string }[] = [];

async function insertGown(
  name: string,
  priceStatus: "priced" | "on_request",
  priceMinor: number | null,
) {
  const id = randomUUID();
  gownIds.push(id);
  await sql`
    INSERT INTO gowns (id, slug, name, status, price_status, price_minor, created_at)
    VALUES (${id}, ${`catalogue-${id}`}, ${name}, 'published', ${priceStatus}, ${priceMinor}, now())
  `;
  return id;
}

async function insertTaxonomy(
  table: "silhouettes" | "materials" | "collections",
  slug: string,
  isActive: boolean,
) {
  const id = randomUUID();
  taxonomyIds.push({ table, id });
  await sql`
    INSERT INTO ${sql(table)} (id, name, slug, is_active)
    VALUES (${id}, ${slug}, ${slug}, ${isActive})
  `;
  return id;
}

afterAll(async () => {
  if (gownIds.length) await sql`DELETE FROM gowns WHERE id = ANY(${gownIds}::uuid[])`;
  for (const { table, id } of taxonomyIds) {
    await sql`DELETE FROM ${sql(table)} WHERE id = ${id}`;
  }
  await sql.end();
});

describe("catalogue canonical filters and pricing", () => {
  it("302 redirects unknown and inactive taxonomy slugs with canonical Location", async () => {
    const unknown = `unknown-${randomUUID()}`;
    await expect(
      GownsPage({ searchParams: Promise.resolve({ silhouette: unknown }) }),
    ).rejects.toMatchObject({
      digest: expect.stringContaining(`NEXT_REDIRECT;replace;/gowns;302;`),
    });

    const inactive = `inactive-${randomUUID()}`;
    await insertTaxonomy("silhouettes", inactive, false);
    await expect(
      GownsPage({ searchParams: Promise.resolve({ silhouette: inactive }) }),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/gowns;302;"),
    });
  });

  it("price bounds exclude on-request gowns and keep priced results", async () => {
    const prefix = `Bounds ${randomUUID()}`;
    const pricedLow = await insertGown(`${prefix} low`, "priced", 10000);
    const pricedHigh = await insertGown(`${prefix} high`, "priced", 20000);
    const onRequest = await insertGown(`${prefix} request`, "on_request", null);
    const result = await listCatalogue(
      gownFilterQuerySchema.parse({ q: prefix, price_min: "150", sort: "price_asc" }),
    );
    const ids = result.cards.map((card) => card.id);

    expect(ids).toEqual([pricedHigh]);
    expect(ids).not.toContain(pricedLow);
    expect(ids).not.toContain(onRequest);
  });

  it.each(["newest", "price_asc", "price_desc"] as const)(
    "puts on-request gowns last for %s ordering",
    async (sort) => {
      const prefix = `Ordering ${randomUUID()}`;
      const priced = await insertGown(`${prefix} priced`, "priced", 30000);
      const onRequest = await insertGown(`${prefix} request`, "on_request", null);
      const result = await listCatalogue(gownFilterQuerySchema.parse({ q: prefix, sort }));
      const ids = result.cards.map((card) => card.id);

      expect(ids).toEqual([priced, onRequest]);
    },
  );
});
