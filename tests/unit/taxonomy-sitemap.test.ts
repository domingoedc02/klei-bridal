import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/services/catalogue", () => ({ listActiveVocabulary: vi.fn() }));

import { buildSitemap } from "../../app/sitemap";
import { generateMetadata } from "../../app/(public)/gowns/page";

const SITE = "https://kleibridal.test";
const row = (slug: string) => ({ slug, name: slug });

describe("taxonomy sitemap + canonical (KBS-88-2)", () => {
  it("lists /gowns and only the live successor slug, never an old alias", () => {
    const urls = buildSitemap(SITE, {
      silhouettes: [row("a-line")],
      materials: [row("silk")],
      collections: [row("new-slug")], // "old-slug" is aliased to this and so absent
    }).map((entry) => entry.url);

    expect(urls).toEqual([
      `${SITE}/gowns`,
      `${SITE}/gowns?silhouette=a-line`,
      `${SITE}/gowns?material=silk`,
      `${SITE}/gowns?collection=new-slug`,
    ]);
    expect(urls.join("\n")).not.toContain("old-slug");
  });

  it("emits only absolute same-origin URLs", () => {
    const urls = buildSitemap(SITE, {
      silhouettes: [],
      materials: [],
      collections: [row("new-slug")],
    }).map((entry) => new URL(entry.url).origin);
    expect(new Set(urls)).toEqual(new Set([SITE]));
  });

  it("canonical of a live-slug filter URL is that same URL", async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ collection: "new-slug" }),
    });
    expect(metadata.alternates?.canonical).toBe("/gowns?collection=new-slug");
  });
});
