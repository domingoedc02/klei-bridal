import type { Metadata } from "next";
import type { ReactNode } from "react";

// Entire staff area is noindex. Authorisation itself is enforced
// server-side per request (withPipeline, KBS-11/KBS-27) — this layout
// only keeps crawlers out, it is not the access control.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
