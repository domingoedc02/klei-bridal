import type { MetadataRoute } from "next";

// /admin and /e/* are kept out of the index — the latter also carries a
// per-response X-Robots-Tag: noindex (KBS-28), this is the crawler-level
// backstop.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/e/"] }],
    sitemap: "/sitemap.xml",
  };
}
