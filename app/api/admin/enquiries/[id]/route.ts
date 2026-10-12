import type { NextRequest } from "next/server";
import { z } from "zod";

import { withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { getEnquiryDetail } from "@/server/services/admin-enquiries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }>; principal: Principal };

async function handler(request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(
    await getEnquiryDetail(id, context.principal, clientIp(request.headers)),
    // Personal data: never cached by the browser or anything in between.
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = withPipeline(handler, { auth: "staff", rateLimit: null, params: Params });
