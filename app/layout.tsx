import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "Klei Bridal Studio",
    template: "%s — Klei Bridal Studio",
  },
  description: "Klei Bridal Studio — bridal gowns, by appointment and by enquiry.",
};

// Root layout. Server component, no "use client" — every public page
// under it inherits SSR by default (spec/file-structure rule 1).
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
