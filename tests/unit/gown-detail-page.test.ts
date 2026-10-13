import { describe, expect, it, vi } from "vitest";

import GownDetailPage from "../../app/(public)/gowns/[slug]/page";
import { resolvePublishedGownSlug } from "@/server/services/gowns";

vi.mock("@/server/services/gowns", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/services/gowns")>("@/server/services/gowns");
  return { ...actual, resolvePublishedGownSlug: vi.fn() };
});

const resolve = vi.mocked(resolvePublishedGownSlug);

const published = (overrides: Record<string, unknown> = {}) => ({
  kind: "canonical" as const,
  gown: {
    id: "gown-1",
    slug: "silk-dress",
    name: "Silk Dress",
    description: "A silk gown.",
    priceMinor: 125000,
    currency: "PHP",
    priceStatus: "priced",
    isInStock: true,
    images: [
      {
        id: "private-image-id",
        altText: null,
        width: 1200,
        height: 1600,
        lqip: null,
        isHero: true,
        derivatives: {
          "1024": {
            avif: "aa/bb/hash-1024.avif",
            webp: "aa/bb/hash-1024.webp",
            jpeg: "aa/bb/hash-1024.jpg",
          },
          "2048": { jpeg: "aa/bb/hash-2048.jpg" },
        },
      },
    ],
    ...overrides,
  },
});

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { props?: { children?: unknown } };
  const children = node.props?.children;
  return Array.isArray(children) ? children.map(textContent).join(" ") : textContent(children);
}

describe("GownDetailPage SSR", () => {
  it("renders exact price, stock status, and derivative-only gallery data", async () => {
    resolve.mockResolvedValueOnce(published());
    const page = await GownDetailPage({ params: Promise.resolve({ slug: "silk-dress" }) });
    const rendered = textContent(page);
    const children = page.props.children as unknown[];
    const gallery = children.find((child) => {
      if (typeof child !== "object" || child === null || !("type" in child)) return false;
      const type = child.type;
      return typeof type === "function" && type.name === "GownGallery";
    }) as { props: { images: Array<{ id: string; derivatives: Record<string, unknown> }> } };

    expect(rendered).toContain("PHP 1,250.00");
    expect(rendered).toContain("Available now");
    expect(gallery.props.images[0]?.derivatives["1024"]).toBeDefined();
    expect(textContent(page)).not.toContain("/media/private-image-id");
  });

  it("renders Price on request when price is not publicly priced", async () => {
    resolve.mockResolvedValueOnce(published({ priceMinor: null, priceStatus: "on_request" }));
    const page = await GownDetailPage({ params: Promise.resolve({ slug: "silk-dress" }) });
    expect(textContent(page)).toContain("Price on request");
  });
});
