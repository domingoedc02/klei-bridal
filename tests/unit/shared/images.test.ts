import { describe, expect, it } from "vitest";
import { altFor, heroFirst, largest, srcSet, type GalleryImage } from "@/shared/images";
import { GALLERY_SIZES } from "@/components/public/GownGallery";

const row = (w: number) => ({
  avif: `aa/bb/${w}.avif`,
  webp: `aa/bb/${w}.webp`,
  jpeg: `aa/bb/${w}.jpg`,
});
const image: GalleryImage = {
  id: "1",
  altText: "  ",
  width: 1600,
  height: 2400,
  lqip: "data:image/webp;base64,AAAA",
  isHero: false,
  derivatives: {
    "320": row(320),
    "480": row(480),
    "768": row(768),
    "1024": row(1024),
    "1440": row(1440),
    "2048": row(2048),
    social: { jpeg: "cc/dd/social.jpg" },
  },
};

describe("gallery image helpers (KBS-13-4, decision/images §2.2)", () => {
  it("builds same-origin srcset, clamps widths above the original, skips non-width keys", () => {
    expect(srcSet(image, "avif")).toBe(
      "/media/aa/bb/320.avif 320w, /media/aa/bb/480.avif 480w, /media/aa/bb/768.avif 768w, " +
        "/media/aa/bb/1024.avif 1024w, /media/aa/bb/1440.avif 1440w, /media/aa/bb/2048.avif 1600w",
    );
    expect(srcSet(image, "jpeg")).not.toContain("social");
  });

  it("caps zoom at 2048px and picks the largest under a ceiling", () => {
    const big = { ...image, width: 6000, derivatives: { ...image.derivatives, "3200": row(3200) } };
    expect(srcSet(big, "avif")).not.toContain("3200");
    expect(largest(big, "jpeg")).toBe("/media/aa/bb/2048.jpg");
    expect(largest(image, "jpeg", 1024)).toBe("/media/aa/bb/1024.jpg");
    expect(largest({ derivatives: {} }, "jpeg")).toBeUndefined();
  });

  it("phone sizes resolve to the viewport, so 390px@1x picks 480 not 1024+", () => {
    expect(GALLERY_SIZES.endsWith(", 100vw")).toBe(true);
  });

  it("falls back to generated alt text; puts the hero first", () => {
    expect(altFor(image, "Celestine", 2, 8)).toBe("Celestine — photograph 3 of 8");
    expect(altFor({ altText: "Back and train" }, "Celestine", 0, 8)).toBe("Back and train");
    const list = [
      { isHero: false, n: 1 },
      { isHero: true, n: 2 },
      { isHero: false, n: 3 },
    ];
    expect(heroFirst(list).map((x) => x.n)).toEqual([2, 1, 3]);
    expect(heroFirst([{ isHero: false, n: 1 }]).map((x) => x.n)).toEqual([1]);
  });
});
