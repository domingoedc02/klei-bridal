import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline, type Principal } from "@/server/pipeline";
import { publishAdminGown } from "@/server/services/admin-gowns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }>; principal: Principal };

async function handler(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(await publishAdminGown(id, context.principal));
}

export const POST = withPipeline(handler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
});
