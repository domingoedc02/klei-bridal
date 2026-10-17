import type { NextRequest } from "next/server";

import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { withPipeline, type Principal } from "@/server/pipeline";
import {
  adminSettingsPatchSchema,
  getAdminSettings,
  updateAdminSettings,
} from "@/server/services/admin-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "cache-control": "no-store" } };

type Context = {
  principal: Principal;
  body: Parameters<typeof updateAdminSettings>[0];
};

async function get() {
  return Response.json(await getAdminSettings(), noStore);
}

async function patch(request: NextRequest, context: Context) {
  return Response.json(
    await updateAdminSettings(context.body, context.principal, clientIp(request.headers)),
    noStore,
  );
}

export const GET = withPipeline(get, { auth: "staff", rateLimit: null });
export const PATCH = withPipeline(patch, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  body: adminSettingsPatchSchema,
});
