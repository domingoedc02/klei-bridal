import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { PipelineError, withPipeline, type Principal } from "@/server/pipeline";
import { deleteAdminGown, getAdminGown, updateAdminGown } from "@/server/services/admin-gowns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().max(80).optional(),
  description: z.string().max(10_000).nullable().optional(),
  silhouette_id: z.string().uuid().nullable().optional(),
  material_ids: z.array(z.string().uuid()).max(100).optional(),
  collection_ids: z.array(z.string().uuid()).max(100).optional(),
  price_status: z.enum(["priced", "on_request", "unlisted"]).optional(),
  price_minor: z.number().int().safe().positive().nullable().optional(),
  currency: z.string().length(3).optional(),
  is_in_stock: z.boolean().optional(),
  status: z.enum(["draft", "archived"]).optional(),
});
type Context = {
  params: Promise<{ id: string }>;
  principal: Principal;
  body?: z.infer<typeof Body>;
};

async function getHandler(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(await getAdminGown(id));
}
async function patchHandler(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!context.body) throw new PipelineError(400, "BAD_REQUEST", "Request body is required.");
  return Response.json(await updateAdminGown(id, context.body, context.principal));
}
async function deleteHandler(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  await deleteAdminGown(id, context.principal);
  return new Response(null, { status: 204 });
}

export const GET = withPipeline(getHandler, { auth: "staff", rateLimit: null, params: Params });
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
