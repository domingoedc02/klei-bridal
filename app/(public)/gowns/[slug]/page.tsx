import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import GownGallery from "@/components/public/GownGallery";
import { env } from "@/config/env";
import {
  metadataDescription,
  resolvePublishedGownSlug,
  type GownImageForMetadata,
  type PublishedGown,
} from "@/server/services/gowns";

type Props = { params: Promise<{ slug: string }> };

/** The hero's 1200×630 JPEG crop path (KBS-13), or undefined if it was never encoded. */
function socialPath(gown: PublishedGown): string | undefined {
  const hero: GownImageForMetadata | undefined =
    gown.images.find((image) => image.isHero) ?? gown.images[0];
  const social = (hero?.derivatives as { social?: { jpeg?: unknown } } | null)?.social?.jpeg;
  return typeof social === "string" && social ? social : undefined;
}

/** Per-gown og:/twitter: tags (KBS-15). Absolute URLs from server-only SITE_URL. */
export function buildGownMetadata(gown: PublishedGown, siteUrl: string): Metadata {
  const crop = socialPath(gown);
  // spec/api/admin-images: a lost derivative degrades to the site brand card, never a 500.
  const imageUrl = crop ? `${siteUrl}/media/${crop}` : `${siteUrl}/opengraph-image`;
  const description = metadataDescription(gown);
  return {
    title: gown.name,
    description,
    alternates: { canonical: `${siteUrl}/gowns/${gown.slug}` },
    openGraph: {
      title: gown.name,
      description,
      url: `${siteUrl}/gowns/${gown.slug}`,
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: gown.name }],
    },
    twitter: { card: "summary_large_image", title: gown.name, description, images: [imageUrl] },
  };
}

/** Draft, archived and unknown slugs get NO metadata: no image paths or hashes leak. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const result = await resolvePublishedGownSlug((await params).slug);
  return result.kind === "missing" ? {} : buildGownMetadata(result.gown, env.SITE_URL);
}

// Gown detail (KBS-10 builds the real page). Server component; no "use client" here.
export default async function GownDetailPage({ params }: Props) {
  const result = await resolvePublishedGownSlug((await params).slug);
  if (result.kind === "missing") notFound();
  // 308, not 301: App Router pages cannot emit 301 (decision/slug-redirect-status).
  if (result.kind === "redirect") permanentRedirect(`${env.SITE_URL}/gowns/${result.gown.slug}`);
  const { gown } = result;
  return (
    <main>
      <h1>{gown.name}</h1>
      {gown.description ? <p>{gown.description}</p> : null}
      <GownGallery
        gownName={gown.name}
        images={gown.images.map((image) => ({
          ...image,
          altText: image.altText ?? null,
          lqip: image.lqip ?? null,
          width: image.width ?? 1200,
          height: image.height ?? 1600,
          derivatives: image.derivatives as Record<
            string,
            Partial<Record<"avif" | "webp" | "jpeg", string>>
          >,
        }))}
      />
    </main>
  );
}
