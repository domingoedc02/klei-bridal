import type { NextRequest } from "next/server";
import { z } from "zod";

import { withPipeline, type Principal } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { setGownHero } from "@/server/services/admin-gown-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });
type Context = { params: Promise<{ id: string; imageId: string }>; principal: Principal };

async function handler(request: NextRequest, context: Context) {
  const { id, imageId } = await context.params;
  return Response.json(
    await setGownHero(id, imageId, context.principal, clientIp(request.headers)),
  );
}

export const POST = withPipeline(handler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
});
