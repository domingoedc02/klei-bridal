import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { contentSecurityPolicy } from "@/server/pipeline/headers";

export const metadata: Metadata = {
  title: {
    default: "Klei Bridal Studio",
    template: "%s — Klei Bridal Studio",
  },
  description: "Klei Bridal Studio — bridal gowns, by appointment and by enquiry.",
};

/** Root server layout. Middleware supplies one nonce for this response. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <head>
        {nonce ? (
          <meta
            httpEquiv="Content-Security-Policy-Report-Only"
            content={contentSecurityPolicy(nonce)}
          />
        ) : null}
      </head>
      <body>{children}</body>
    </html>
  );
}
