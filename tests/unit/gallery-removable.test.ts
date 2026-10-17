import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { largest, srcSet, type GalleryImage } from "@/shared/images";

// The component under test uses the classic JSX runtime (no React import).
(globalThis as { React?: unknown }).React = React;

// KBS-12 cut-order position 1: zoom must be removable without touching the
// gown page, and a missing 2048 derivative must fall back, not break.

const row = (n: number) => ({ avif: `a/${n}.avif`, webp: `a/${n}.webp`, jpeg: `a/${n}.jpg` });
const image = (derivatives: GalleryImage["derivatives"]): GalleryImage => ({
  id: "i1",
  altText: null,
  width: 2048,
  height: 2048,
  lqip: null,
  isHero: true,
  derivatives,
});
const full = image({ "320": row(320), "1440": row(1440), "2048": row(2048) });

describe("zoom asset fallback", () => {
  it("falls back to the next-best resolution when the 2048 derivative is absent", () => {
    const encoding = image({ "320": row(320), "1440": row(1440) });
    expect(srcSet(encoding, "avif")).toBe("/media/a/320.avif 320w, /media/a/1440.avif 1440w");
    expect(largest(encoding, "avif")).toBe("/media/a/1440.avif");
  });
  it("never offers anything above 2048px", () => {
    const huge = image({ ...full.derivatives, "3200": row(3200) });
    expect(srcSet(huge, "avif")).not.toContain("3200");
  });
});

describe("gallery without the zoom code", () => {
  it("renders identical markup when ZoomView is absent", async () => {
    const { default: GownGallery } = await import("@/components/public/GownGallery");
    const props = { gownName: "Celestine", images: [full] };
    const withZoom = renderToStaticMarkup(createElement(GownGallery, props));

    vi.resetModules();
    vi.doMock("@/components/public/ZoomView", () => ({ default: () => null }));
    const { default: Bare } = await import("@/components/public/GownGallery");
    const without = renderToStaticMarkup(createElement(Bare, props));
    vi.doUnmock("@/components/public/ZoomView");

    expect(without).toBe(withZoom);
    expect(withZoom).not.toContain("<dialog");
    expect(withZoom).toContain('href="/media/a/2048.avif"');
  });
});
