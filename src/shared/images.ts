// Pure image-source helpers for the public gallery (decision/images §2.2).
// Shared so the server page (KBS-10) and client components build identical URLs.

/** width → format → cache-relative path, as written by src/server/worker/imageWorker.ts. */
export type DerivativeManifest = Record<string, Partial<Record<"avif" | "webp" | "jpeg", string>>>;

export type GalleryImage = {
  id: string;
  altText: string | null;
  width: number;
  height: number;
  lqip: string | null;
  isHero: boolean;
  derivatives: DerivativeManifest;
};

export const MEDIA_PREFIX = "/media/";
export const ZOOM_WIDTH = 2048;

type Format = "avif" | "webp" | "jpeg";

export function srcSet(
  image: Pick<GalleryImage, "derivatives" | "width">,
  format: Format,
  maxWidth = ZOOM_WIDTH,
): string {
  const seen = new Set<number>();
  return Object.keys(image.derivatives)
    .map(Number)
    .filter((w) => Number.isInteger(w) && w > 0 && w <= maxWidth)
    .sort((a, b) => a - b)
    .flatMap((w) => {
      const path = image.derivatives[String(w)]?.[format];
      const real = Math.min(w, image.width);
      if (!path || seen.has(real)) return [];
      seen.add(real);
      return [`${MEDIA_PREFIX}${path} ${real}w`];
    })
    .join(", ");
}

export function largest(
  image: Pick<GalleryImage, "derivatives">,
  format: Format,
  maxWidth = ZOOM_WIDTH,
): string | undefined {
  const w = Object.keys(image.derivatives)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n <= maxWidth && image.derivatives[String(n)]?.[format])
    .sort((a, b) => b - a)[0];
  return w === undefined ? undefined : `${MEDIA_PREFIX}${image.derivatives[String(w)]![format]}`;
}

export function derivativeLongestEdge(
  image: Pick<GalleryImage, "derivatives">,
  format: Format,
  maxWidth = ZOOM_WIDTH,
): number | undefined {
  const widths = Object.entries(image.derivatives)
    .map(([width, formats]) => ({ width: Number(width), path: formats?.[format] }))
    .filter(({ width, path }) => Number.isInteger(width) && width > 0 && width <= maxWidth && path)
    .map(({ width }) => width);
  return widths.length ? Math.max(...widths) : undefined;
}

export function altFor(
  image: Pick<GalleryImage, "altText">,
  gownName: string,
  index: number,
  total: number,
): string {
  const alt = image.altText?.trim();
  return alt ? alt : `${gownName} — photograph ${index + 1} of ${total}`;
}

export function heroFirst<T extends Pick<GalleryImage, "isHero">>(images: T[]): T[] {
  const i = images.findIndex((img) => img.isHero);
  return i <= 0 ? images : [images[i]!, ...images.slice(0, i), ...images.slice(i + 1)];
}
