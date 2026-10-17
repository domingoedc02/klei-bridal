import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "../../middleware";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const liveId = crypto.randomUUID();
const oldSlug = `old-${liveId}`;
const liveSlug = `live-${liveId}`;

beforeAll(async () => {
  await sql`
    INSERT INTO collections (id, name, slug, is_active)
    VALUES (${liveId}, ${liveSlug}, ${liveSlug}, true)
  `;
  await sql`
    INSERT INTO taxonomy_slug_redirects (vocabulary, old_slug, target_id)
    VALUES ('collections', ${oldSlug}, ${liveId})
  `;
});

afterAll(async () => {
  await sql`DELETE FROM taxonomy_slug_redirects WHERE old_slug = ${oldSlug}`;
  await sql`DELETE FROM collections WHERE id = ${liveId}`;
  await sql.end();
});

describe("taxonomy slug redirects", () => {
  it("returns exact 301, relative Location, and one-day cache header", async () => {
    const response = await middleware(
      new NextRequest(`http://localhost:3000/collections/${oldSlug}`),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/collections/${liveSlug}`);
    expect(response.headers.get("location")).toMatch(/^\/(collections|silhouettes|materials)\//);
    expect(response.headers.get("location")).not.toMatch(/^\/\//);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("does not redirect a live slug or emit a user-derived target", async () => {
    const response = await middleware(
      new NextRequest(`http://localhost:3000/collections/${liveSlug}?next=https://evil.example`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rewrites filter aliases without carrying hostile unknown parameters", async () => {
    const response = await middleware(
      new NextRequest(
        `http://localhost:3000/gowns?collection=${oldSlug}&next=https://evil.example`,
      ),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`/gowns?collection=${liveSlug}`);
  });
});
