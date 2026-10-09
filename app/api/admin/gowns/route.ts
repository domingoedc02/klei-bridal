import type { NextRequest } from "next/server";
import { z } from "zod";

import { budgets } from "@/server/ratelimit/budgets";
import { PipelineError, withPipeline, type Principal } from "@/server/pipeline";
import { createAdminGown, listAdminGowns } from "@/server/services/admin-gowns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ids = z.array(z.string().uuid()).max(100).default([]);
const GownBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(80).optional(),
  description: z.string().max(10_000).nullable().optional(),
  silhouette_id: z.string().uuid().nullable().optional(),
  material_ids: ids,
  collection_ids: ids,
  price_status: z.enum(["priced", "on_request", "unlisted"]),
  price_minor: z.number().int().safe().positive().nullable(),
  currency: z.string().length(3),
  is_in_stock: z.boolean().default(false),
});
const Query = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(100).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

type Context = {
  principal: Principal;
  body?: z.infer<typeof GownBody>;
  query?: z.infer<typeof Query>;
};

async function getHandler(_request: NextRequest, context: Context) {
  return Response.json(await listAdminGowns(context.query ?? Query.parse({}), undefined));
}

async function postHandler(_request: NextRequest, context: Context) {
  if (!context.body) throw new PipelineError(400, "BAD_REQUEST", "Request body is required.");
  return Response.json(await createAdminGown(context.body, context.principal), { status: 201 });
}

export const GET = withPipeline(getHandler, { auth: "staff", rateLimit: null, query: Query });
export const POST = withPipeline(postHandler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  body: GownBody,
});
