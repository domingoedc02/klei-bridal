import type { Metadata } from "next";
import { headers } from "next/headers";
import { cookies } from "next/headers";
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
      <main>
        <h1>Klei Bridal Studio</h1>
        <p>This enquiry is closed. Please contact Klei Bridal Studio.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Klei Bridal Studio</h1>
      <p>Enquiry reference</p>
      <p><strong>{result.view.reference}</strong></p>
      <ul>
        {result.view.gowns.map((gown) => (
          <li key={`${gown.name}-${gown.imageUrl ?? "no-image"}`}>
            {gown.imageUrl ? <img src={gown.imageUrl} alt={gown.name} /> : null}
            <p>{gown.name}</p>
          </li>
        ))}
      </ul>
      <p>Full details are visible to Klei Bridal Studio staff.</p>
    </main>
  );
}
