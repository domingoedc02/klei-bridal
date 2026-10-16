import type { Metadata } from "next";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";

import { env } from "@/config/env";
import { SESSION_COOKIE } from "@/server/auth/session";
import { enforceRateLimit } from "@/server/pipeline/rate-limit";
import { PipelineError } from "@/server/pipeline/errors";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { getRateLimitStore } from "@/server/ratelimit";
import { pagePrincipal, resolveShortLink } from "@/server/services/short-link";
import { buildShortLinkMetadata } from "@/server/short-link/render";

import styles from "./page.module.css";

export { buildShortLinkMetadata };

export function generateMetadata(): Metadata {
  return buildShortLinkMetadata(env.SITE_URL);
}

/**
 * Public short-link page. Server-only resolver receives only neutral fields;
 * unknown, archived and erased links share the same closed response. Staff
 * access redirects after the audited read, so the token leaves the URL bar.
 */
export default async function ShortLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders);
  try {
    await enforceRateLimit(budgets.enquiryLink, ip, getRateLimitStore());
  } catch (error) {
    // This budget is fail-open. Only an actual 429 should surface; Valkey
    // outages are swallowed by enforceRateLimit's fail-open branch.
    if (error instanceof PipelineError && error.status === 429) throw error;
  }
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  const principal = await pagePrincipal(sessionToken);
  const result = await resolveShortLink(token, principal, ip);
  if (result.kind === "staff") redirect(`/admin/enquiries/${result.enquiryId}`);

  // Keep page output field-scoped. Renderer is exported for API/tests and
  // defines metadata/escaping; JSX avoids raw HTML injection here.
  if (result.kind === "closed") {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <p className={styles.brand}>Klei Bridal Studio</p>
          <section className={styles.closed} aria-labelledby="closed-title">
            <h1 className={styles.closedTitle} id="closed-title">
              This enquiry is closed
            </h1>
            <p className={styles.closedText}>
              Please contact Klei Bridal Studio if you need help with your enquiry.
            </p>
          </section>
        </div>
      </main>
    );
  }
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <p className={styles.brand}>Klei Bridal Studio</p>
        <section className={styles.intro} aria-labelledby="enquiry-title">
          <h1 className={styles.title} id="enquiry-title">
            Your enquiry is with us
          </h1>
          <p className={styles.lede}>
            Keep this page as your reference while we help you find your gown.
          </p>
        </section>
        <section className={styles.reference} aria-label="Enquiry reference">
          <span className={styles.referenceLabel}>Enquiry reference</span>
          <strong className={styles.referenceValue}>{result.view.reference}</strong>
        </section>
        {result.view.gowns.length ? (
          <section className={styles.gowns} aria-labelledby="gowns-title">
            <h2 className={styles.gownsTitle} id="gowns-title">
              Your selected gowns
            </h2>
            <ul className={styles.gownList}>
              {result.view.gowns.map((gown) => (
                <li className={styles.gown} key={`${gown.name}-${gown.imageUrl ?? "no-image"}`}>
                  {gown.imageUrl ? (
                    <img className={styles.gownImage} src={gown.imageUrl} alt={gown.name} />
                  ) : null}
                  <p className={styles.gownName}>{gown.name}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className={styles.note}>
          Full details are visible to Klei Bridal Studio staff.
        </p>
      </div>
    </main>
  );
}
