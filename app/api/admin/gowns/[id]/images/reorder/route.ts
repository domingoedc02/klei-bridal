import type { NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/config/env";
import { withPipeline, type Principal } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { reorderGownImages } from "@/server/services/admin-gown-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ order: z.array(z.string().uuid()).min(1).max(env.IMAGE_MAX_PER_GOWN) });
type Context = {
  params: Promise<{ id: string }>;
  principal: Principal;
  body: z.infer<typeof Body>;
};

async function handler(request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(
    await reorderGownImages(id, context.body.order, context.principal, clientIp(request.headers)),
  );
}

export const PATCH = withPipeline(handler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: Body,
});
