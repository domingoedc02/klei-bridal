import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { eraseEnquiry } from "@/server/services/admin-enquiries";
import { enquiryErasePatchSchema } from "@/shared/schemas/enquiryAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
type Context = {
  params: Promise<{ id: string }>;
  principal: Principal;
  body: z.infer<typeof enquiryErasePatchSchema>;
};

async function handler(request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(
    await eraseEnquiry(id, context.body.reason, context.principal, clientIp(request.headers)),
    { headers: { "cache-control": "no-store" } },
  );
}

export const POST = withPipeline(handler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: enquiryErasePatchSchema,
});
