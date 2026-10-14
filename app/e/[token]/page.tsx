import type { Metadata } from "next";

import { env } from "@/config/env";

// Short-link enquiry view. Neutral og:, noindex, and — critically — no
// personal data for an unauthenticated viewer (spec/api, decision/enquiry-link).
// A miss and an archived enquiry must return the SAME neutral response,
// never a distinguishable 404 (anti-enumeration). An ERASED enquiry gets that
// same response too: check `isErased` from @/server/services/enquiry-erasure,
// never `email IS NULL` inline (spec/api/admin-enquiries). Real implementation:
// KBS-19 / KBS-29.
const SHORT_LINK_TITLE = "Klei Bridal Studio — Enquiry";
const SHORT_LINK_DESCRIPTION = "View your enquiry reference from Klei Bridal Studio.";

/** Neutral tags only: no token, name, contact or gown data (decision/enquiry-link). */
export function buildShortLinkMetadata(siteUrl: string): Metadata {
  const image = {
    url: `${siteUrl}/opengraph-image`,
    width: 1200,
    height: 630,
    alt: "Klei Bridal Studio",
  };
  return {
    title: SHORT_LINK_TITLE,
    description: SHORT_LINK_DESCRIPTION,
    robots: { index: false, follow: false },
    openGraph: {
      title: SHORT_LINK_TITLE,
      description: SHORT_LINK_DESCRIPTION,
      type: "website",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: SHORT_LINK_TITLE,
      description: SHORT_LINK_DESCRIPTION,
      images: [image.url],
    },
  };
}

export function generateMetadata(): Metadata {
  return buildShortLinkMetadata(env.SITE_URL);
}

export default async function ShortLinkPage({ params }: { params: Promise<{ token: string }> }) {
  await params; // token resolution lands with KBS-19/KBS-29
  return (
    <main>
      <h1>Klei Bridal Studio</h1>
      <p>Short-link placeholder (KBS-6) — real content lands with KBS-19.</p>
    </main>
  );
}
