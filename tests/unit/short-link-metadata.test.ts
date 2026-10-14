import { describe, expect, it } from "vitest";

import { buildShortLinkMetadata } from "../../app/e/[token]/page";

const SITE = "https://kleibridal.test";

describe("buildShortLinkMetadata (KBS-15-3)", () => {
  it("is neutral, noindex and uses the absolute site card, never the token or a gown", () => {
    const m = buildShortLinkMetadata(SITE);
    const card = `${SITE}/opengraph-image`;
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.openGraph).toMatchObject({ images: [{ url: card, width: 1200, height: 630 }] });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", images: [card] });
    expect(JSON.stringify(m)).not.toMatch(/\/media\/|\/gowns\/|tok/i);
  });
});
