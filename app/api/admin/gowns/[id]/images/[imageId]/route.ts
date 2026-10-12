import type { NextRequest } from "next/server";
import { z } from "zod";

import { withPipeline, type Principal } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { deleteGownImage, updateGownImageAlt } from "@/server/services/admin-gown-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });
// Empty is allowed: alt is not required yet (KBS-21 open question 1).
const Body = z.object({ alt: z.string().trim().max(250) }).strict();
type Context = {
  params: Promise<{ id: string; imageId: string }>;
  principal: Principal;
};

async function patchHandler(
  request: NextRequest,
  context: Context & { body: z.infer<typeof Body> },
) {
  const { id, imageId } = await context.params;
  return Response.json(
    await updateGownImageAlt(
      id,
      imageId,
      context.body.alt,
      context.principal,
      clientIp(request.headers),
    ),
  );
}

async function deleteHandler(request: NextRequest, context: Context) {
  const { id, imageId } = await context.params;
  await deleteGownImage(id, imageId, context.principal, clientIp(request.headers));
  return new Response(null, { status: 204 });
}

export const PATCH = withPipeline(patchHandler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  body: Body,
});

export const DELETE = withPipeline(deleteHandler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
});
