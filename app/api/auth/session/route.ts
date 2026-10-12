import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/server/auth/session";
import { withPipeline, type Principal } from "@/server/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function get(request: NextRequest, context: { principal: Principal }) {
  const response = NextResponse.json(
    {
      staff: context.principal.staff,
      password_change_pending: Boolean(context.principal.passwordChangeRequired),
    },
    { headers: { "cache-control": "no-store" } },
  );
  if (!request.cookies.get(SESSION_COOKIE)?.value) return response;
  return response;
}

export const GET = withPipeline(get, {
  auth: "staff",
  rateLimit: null,
  allowPendingPasswordChange: true,
});
