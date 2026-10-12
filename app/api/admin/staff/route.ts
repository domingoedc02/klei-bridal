import type { NextRequest } from "next/server";

import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { createStaff, listStaff } from "@/server/services/admin-staff";
import { staffCreateSchema, type StaffCreate } from "@/shared/schemas/staffAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { principal: Principal; body: StaffCreate };

// Staff names and emails are personal data: never cached.
async function get() {
  return Response.json(await listStaff(), { headers: { "cache-control": "no-store" } });
}

async function post(request: NextRequest, context: Context) {
  return Response.json(
    await createStaff(context.body, context.principal, clientIp(request.headers)),
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

export const GET = withPipeline(get, { auth: "staff", rateLimit: null });
export const POST = withPipeline(post, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  body: staffCreateSchema,
});
