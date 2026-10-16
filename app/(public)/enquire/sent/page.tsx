import type { Metadata } from "next";
import Link from "next/link";
import { ENQUIRY_REFERENCE_PATTERN } from "@/shared/enquiryForm";

// KBS-89: where the no-JS form lands after a 303. Echoes only the
// regex-validated reference — no DB lookup, no PII (decision/enquiry-nojs-csrf).
export const metadata: Metadata = {
  title: "Enquiry sent",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function EnquirySentPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[] }>;
}) {
  const { ref } = await searchParams;
  const reference = typeof ref === "string" && ENQUIRY_REFERENCE_PATTERN.test(ref) ? ref : null;
  return (
    <main className="sent">
      <h1>Thank you</h1>
      <meta name="robots" content="noindex,nofollow" />
      <p>Your enquiry was sent. We will be in touch soon.</p>
      {reference ? (
        <p>
          Your reference is <strong>{reference}</strong>. Keep it if you want to ask about this
          enquiry.
        </p>
      ) : null}
      <p>A copy of your enquiry was also emailed to you.</p>
      <p>
        <Link href="/gowns">Keep browsing gowns</Link>
      </p>
      <style>{`
        .sent { max-width: 52rem; margin: 0 auto; padding: 2rem 1rem; color: #2b2825; }
        .sent h1 { font-family: Fraunces, Georgia, serif; font-weight: 500; }
        .sent a { display: inline-flex; align-items: center; min-height: 2.75rem; color: #2b2825; font-weight: 700; }
        .sent a:focus-visible { outline: 2px solid #6e5420; outline-offset: 2px; }
      `}</style>
    </main>
  );
}
