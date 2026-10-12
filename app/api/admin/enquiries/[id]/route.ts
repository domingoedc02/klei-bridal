import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { getEnquiryDetail, setEnquiryStatus } from "@/server/services/admin-enquiries";
import { enquiryStatusPatchSchema } from "@/shared/schemas/enquiryAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }>; principal: Principal };
// Personal data: never cached by the browser or anything in between.
const noStore = { headers: { "cache-control": "no-store" } };

async function get(request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(
    await getEnquiryDetail(id, context.principal, clientIp(request.headers)),
    noStore,
  );
}

async function patch(
  request: NextRequest,
  context: Context & { body: z.infer<typeof enquiryStatusPatchSchema> },
) {
  const { id } = await context.params;
  return Response.json(
    await setEnquiryStatus(id, context.body.status, context.principal, clientIp(request.headers)),
    noStore,
  );
}

export const GET = withPipeline(get, { auth: "staff", rateLimit: null, params: Params });
export const PATCH = withPipeline(patch, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: enquiryStatusPatchSchema,
});
