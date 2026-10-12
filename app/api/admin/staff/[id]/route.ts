import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { updateStaff } from "@/server/services/admin-staff";
import { staffPatchSchema, type StaffPatch } from "@/shared/schemas/staffAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }>; principal: Principal; body: StaffPatch };

async function patch(request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(
    await updateStaff(id, context.body, context.principal, clientIp(request.headers)),
    { headers: { "cache-control": "no-store" } },
  );
}

// No DELETE export: a hard delete does not exist by any route (KBS-24 AC).
export const PATCH = withPipeline(patch, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: staffPatchSchema,
});
