import { describe, expect, it } from "vitest";

import { derivativeLongestEdge, derivativeWidthForPath, type GalleryImage } from "@/shared/images";

const image = {
  derivatives: {
    "320": { avif: "aa.avif", webp: "aa.webp", jpeg: "aa.jpg" },
    "1024": { avif: "bb.avif", webp: "bb.webp", jpeg: "bb.jpg" },
    "2048": { avif: "cc.avif", webp: "cc.webp", jpeg: "cc.jpg" },
  },
} as Pick<GalleryImage, "derivatives">;

describe("derivative manifest metadata", () => {
  it("resolves selected content-addressed AVIF to its manifest longest edge", () => {
    expect(derivativeWidthForPath(image, "avif", "cc.avif")).toBe(2048);
    expect(derivativeLongestEdge(image, "avif")).toBe(2048);
  });

  it("does not infer metadata from an unknown path or over-ceiling variant", () => {
    expect(derivativeWidthForPath(image, "avif", "2048.avif")).toBeUndefined();
    expect(derivativeLongestEdge(image, "avif", 1440)).toBe(1024);
  });
});
