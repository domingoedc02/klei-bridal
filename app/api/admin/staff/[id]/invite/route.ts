import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { resendStaffInvitation } from "@/server/services/admin-staff";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ email: z.string().trim().email().max(320).optional() }).strict();
type Context = { params: Promise<{ id: string }>; principal: Principal; body: { email?: string } };

async function post(request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(
    await resendStaffInvitation(id, context.body, context.principal, clientIp(request.headers)),
    { headers: { "cache-control": "no-store" } },
  );
}

export const POST = withPipeline(post, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: Body,
});
