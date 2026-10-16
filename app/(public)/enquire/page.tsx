import type { Metadata } from "next";
import { cookies } from "next/headers";
import EnquiryForm from "@/components/public/EnquiryForm";
import { logger } from "@/server/observability/logger";
import { CSRF_COOKIE, validCsrfToken } from "@/server/pipeline/csrf";
import {
  getChatSettings,
  getLeadTimeSettings,
  parseLeadTimeSettings,
} from "@/server/services/enquiries";
import { isFormErrorCode, type FormErrorCode } from "@/shared/enquiryForm";

export const metadata: Metadata = { title: "Enquire", robots: { index: false, follow: false } };
// Settings are read per request so an admin's change shows on the next visit;
// the page also carries a per-visitor CSRF token, so it is never cached.
export const dynamic = "force-dynamic";

type Search = { error?: string | string[]; fields?: string | string[] };

export default async function EnquirePage({ searchParams }: { searchParams: Promise<Search> }) {
  const [{ error, fields }, jar] = await Promise.all([searchParams, cookies()]);
  // Middleware minted the cookie on this request when she had none.
  const cookie = jar.get(CSRF_COOKIE)?.value;
  const csrfToken = validCsrfToken(cookie) ? cookie! : "";
  const errorCode: FormErrorCode | null =
    typeof error === "string" && isFormErrorCode(error) ? error : null;
  // The notice only informs (decision/lead-time-rule §2.3): a settings read
  // failure falls back to the seed values rather than taking the form down.
  const leadTime = await getLeadTimeSettings().catch((err: unknown) => {
    logger.error({ err }, "enquire: lead-time settings unavailable, using defaults");
    return parseLeadTimeSettings({});
  });
  // Chat hand-offs are optional: no settings, no actions.
  const chatSettings = await getChatSettings().catch((err: unknown) => {
    logger.error({ err }, "enquire: chat settings unavailable, no chat hand-offs");
    return { messengerPage: null, whatsappNumber: null, viberNumber: null };
  });
  return (
    <main>
      <EnquiryForm
        leadTime={leadTime}
        chatSettings={chatSettings}
        csrfToken={csrfToken}
        serverError={errorCode}
        errorFields={typeof fields === "string" ? fields : ""}
      />
    </main>
  );
}
