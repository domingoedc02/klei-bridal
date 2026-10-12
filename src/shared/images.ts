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

/** Derivatives are served by app/media/[...path]/route.ts (same-origin, immutable). */
export const MEDIA_PREFIX = "/media/";
/** decision/images §2.1 amendment: zoom ceiling is the 2048px variant. */
export const ZOOM_WIDTH = 2048;

type Format = "avif" | "webp" | "jpeg";

/**
 * `srcset` for one format. Variants are encoded `withoutEnlargement`, so a
 * width above the original is really the original width: the descriptor is
 * clamped and duplicates dropped, so the browser never trusts a lie.
 */
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

/** The single largest variant ≤ maxWidth in a format, for `src` fallbacks and no-JS zoom links. */
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

/** decision/images §6: caption is alt text; generated fallback so an upload is never blocked. */
export function altFor(
  image: Pick<GalleryImage, "altText">,
  gownName: string,
  index: number,
  total: number,
): string {
  const alt = image.altText?.trim();
  return alt ? alt : `${gownName} — photograph ${index + 1} of ${total}`;
}

/** Hero first (the one `is_hero` row, else the first), rest in given sort order. */
export function heroFirst<T extends Pick<GalleryImage, "isHero">>(images: T[]): T[] {
  const i = images.findIndex((img) => img.isHero);
  return i <= 0 ? images : [images[i]!, ...images.slice(0, i), ...images.slice(i + 1)];
}
