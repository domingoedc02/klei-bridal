import type { Metadata } from "next";
import EnquiryForm from "@/components/public/EnquiryForm";
import { logger } from "@/server/observability/logger";
import { getLeadTimeSettings, parseLeadTimeSettings } from "@/server/services/enquiries";

export const metadata: Metadata = { title: "Enquire" };
// Settings are read per request so an admin's change shows on the next visit.
export const dynamic = "force-dynamic";

export default async function EnquirePage() {
  // The notice only informs (decision/lead-time-rule §2.3): a settings read
  // failure falls back to the seed values rather than taking the form down.
  const leadTime = await getLeadTimeSettings().catch((error: unknown) => {
    logger.error({ err: error }, "enquire: lead-time settings unavailable, using defaults");
    return parseLeadTimeSettings({});
  });
  return (
    <main>
      <EnquiryForm leadTime={leadTime} />
    </main>
  );
}
