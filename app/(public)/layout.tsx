import Link from "next/link";
import type { ReactNode } from "react";

import { PRIVACY_PATH } from "@/shared/privacy";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <footer>
        <Link href={PRIVACY_PATH}>Privacy notice</Link>
      </footer>
    </>
  );
}
