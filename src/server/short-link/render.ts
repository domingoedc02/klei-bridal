import type { Metadata } from "next";

/**
 * The ONLY renderer for the unauthenticated /e/:token page (KBS-29, R10).
 * It is handed exactly four things (studio name is a constant, the rest are
 * these inputs), never the enquiry record, so there is no bride field in
 * scope to serialise by accident. Every value is HTML-escaped.
 */
export interface ShortLinkView {
  reference: string;
  gowns: Array<{ name: string; imageUrl: string | null }>;
}

const STUDIO = "Klei Bridal Studio";
const TITLE = `${STUDIO} — Enquiry`;
const GENERIC_DESCRIPTION = "View your enquiry reference from Klei Bridal Studio.";

/** og:/twitter: values. Neutral and fixed: the reference at most, never a gown or a person. */
export function buildShortLinkMetadata(siteUrl: string, reference?: string): Metadata {
  const image = { url: `${siteUrl}/opengraph-image`, width: 1200, height: 630, alt: STUDIO };
  const description = reference ? `Enquiry reference ${reference}` : GENERIC_DESCRIPTION;
  return {
    title: TITLE,
    description,
    robots: { index: false, follow: false },
    openGraph: { title: TITLE, description, images: [image] },
    twitter: { card: "summary_large_image", title: TITLE, description, images: [image.url] },
  };
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

function head(siteUrl: string, reference?: string): string {
  const m = buildShortLinkMetadata(siteUrl, reference);
  const og = m.openGraph as { title: string; description: string; images: { url: string }[] };
  const image = og.images[0]!.url;
  return [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(TITLE)}</title>`,
    `<meta name="description" content="${esc(og.description)}">`,
    `<meta name="robots" content="noindex, nofollow">`,
    `<meta name="referrer" content="no-referrer">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(STUDIO)}">`,
    `<meta property="og:title" content="${esc(TITLE)}">`,
    `<meta property="og:description" content="${esc(og.description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${esc(STUDIO)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(TITLE)}">`,
    `<meta name="twitter:description" content="${esc(og.description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<style>body{font-family:Georgia,serif;margin:0;padding:2rem 1rem;background:#faf7f4;color:#2b2623}main{max-width:40rem;margin:0 auto}h1{font-size:1.25rem;letter-spacing:.08em;text-transform:uppercase}ul{list-style:none;padding:0;display:grid;gap:1.5rem}img{display:block;max-width:100%;height:auto}</style>`,
  ].join("\n");
}

function document(siteUrl: string, body: string, reference?: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n${head(siteUrl, reference)}\n</head>\n<body>\n<main>\n<h1>${esc(STUDIO)}</h1>\n${body}\n</main>\n</body>\n</html>\n`;
}

/** Unknown, archived and erased enquiries all get exactly this: byte-identical, no token echoed. */
export function renderClosed(siteUrl: string): string {
  return document(
    siteUrl,
    `<p>This enquiry is closed. Please contact Klei Bridal Studio.</p>`,
  );
}

export function renderOpen(siteUrl: string, view: ShortLinkView): string {
  const gowns = view.gowns
    .map(
      (g) =>
        `<li>${g.imageUrl ? `<img src="${esc(g.imageUrl)}" alt="${esc(g.name)}" loading="lazy">` : ""}<p>${esc(g.name)}</p></li>`,
    )
    .join("\n");
  return document(
    siteUrl,
    `<p>Enquiry reference</p>\n<p><strong>${esc(view.reference)}</strong></p>\n<ul>\n${gowns}\n</ul>\n<p>Full details are visible to Klei Bridal Studio staff.</p>`,
    view.reference,
  );
}
