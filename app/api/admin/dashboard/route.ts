import type { NextRequest } from "next/server";

import { withPipeline } from "@/server/pipeline";
import {
  dashboardQuerySchema,
  getAdminDashboard,
  type DashboardQuery,
} from "@/server/services/admin-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { query: DashboardQuery };

async function handler(_request: NextRequest, context: Context) {
  return Response.json(await getAdminDashboard(context.query), {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withPipeline(handler, {
  auth: "staff",
  rateLimit: null,
  query: dashboardQuerySchema,
});
