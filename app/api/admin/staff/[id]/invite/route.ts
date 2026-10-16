import type { NextRequest } from "next/server";
import { z } from "zod";

import { getRateLimitStore } from "@/server/ratelimit";
import { budgets } from "@/server/ratelimit/budgets";
import { enforceRateLimit, PipelineError, withPipeline, type Principal } from "@/server/pipeline";
import { clientIp } from "@/server/ratelimit/client-ip";
import { resendStaffInvitation } from "@/server/services/admin-staff";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ email: z.string().trim().email().max(320).optional() }).strict();
const targetHourly = {
  name: "staff-invite-target",
  dimension: "target",
  limit: 5,
  windowSec: 3600,
  failMode: "closed",
  onExceeded: "429",
} as const;
const targetCooldown = {
  name: "staff-invite-cooldown",
  dimension: "target",
  limit: 1,
  windowSec: 60,
  failMode: "closed",
  onExceeded: "429",
} as const;
const actorDaily = {
  name: "staff-invite-actor",
  dimension: "actor",
  limit: 20,
  windowSec: 86400,
  failMode: "closed",
  onExceeded: "429",
} as const;
type Context = { params: Promise<{ id: string }>; principal: Principal; body: { email?: string } };

async function post(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (id === context.principal.staff.id) {
    throw new PipelineError(409, "CONFLICT", "You cannot resend your own invite.");
  }
  const store = getRateLimitStore();
  await enforceRateLimit(targetHourly, id, store);
  await enforceRateLimit(targetCooldown, id, store);
  await enforceRateLimit(actorDaily, context.principal.sessionId, store);
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
