import { describe, expect, it } from "vitest";

import { buildGownMetadata } from "../../app/(public)/gowns/[slug]/page";
import { metadataDescription, type PublishedGown } from "@/server/services/gowns";

const SITE = "https://kleibridal.test";
const gown = (derivatives: unknown): PublishedGown => ({
  id: "g1",
  slug: "silk-dress",
  name: "Silk Dress",
  description: "A silk gown.",
  images: [
    { id: "i0", isHero: false, derivatives: { social: { jpeg: "aa/bb/not-hero.jpg" } } },
    { id: "i1", isHero: true, derivatives },
  ],
});

describe("buildGownMetadata (KBS-15-1)", () => {
  it("uses the hero's absolute social crop, og:url and summary_large_image", () => {
    const m = buildGownMetadata(gown({ social: { jpeg: "aa/bb/hero-social.jpg" } }), SITE);
    const url = `${SITE}/media/aa/bb/hero-social.jpg`;
    expect(m.openGraph).toMatchObject({
      title: "Silk Dress",
      description: "A silk gown.",
      url: `${SITE}/gowns/silk-dress`,
      type: "website",
      images: [{ url, width: 1200, height: 630 }],
    });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", images: [url] });
  });

  it("falls back to the brand card when the hero crop is missing", () => {
    const m = buildGownMetadata(gown({}), SITE);
    expect(m.openGraph?.images).toEqual([
      { url: `${SITE}/opengraph-image`, width: 1200, height: 630, alt: "Silk Dress" },
    ]);
  });

  it("collapses whitespace and caps og:description at 200 characters", () => {
    expect(metadataDescription({ description: "  a\n\n b  " })).toBe("a b");
    expect(metadataDescription({ description: "x".repeat(300) })).toHaveLength(200);
    expect(metadataDescription({ description: "  " })).toBeUndefined();
  });
});
