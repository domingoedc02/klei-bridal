import type { NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/config/env";
import { withPipeline, type Principal } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { resolveShortLink } from "@/server/services/short-link";
import { renderClosed, renderOpen } from "@/server/short-link/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
type Context = { params: Promise<{ token: string }>; principal: Principal | null };

async function handler(request: NextRequest, context: Context) {
  const { token } = await context.params;
  const result = await resolveShortLink(token, context.principal, clientIp(request.headers));
  if (result.kind === "staff") {
    return new Response(null, {
      status: 302,
      headers: { location: `/admin/enquiries/${result.enquiryId}` },
    });
  }
  const html =
    result.kind === "open" ? renderOpen(env.SITE_URL, result.view) : renderClosed(env.SITE_URL);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export const GET = withPipeline(handler, {
  auth: "public",
  rateLimit: budgets.enquiryLink,
  params: Params,
});
