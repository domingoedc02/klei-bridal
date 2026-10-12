import type { NextRequest } from "next/server";
import { z } from "zod";

import { validate, withPipeline } from "@/server/pipeline";
import { ENQUIRY_STATUSES, listEnquiries } from "@/server/services/admin-enquiries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(24),
  search: z.string().trim().min(1).max(100).optional(),
});
// Repeatable (?status=new&status=read): read with getAll, which the pipeline's single-value query parse cannot.
const Repeated = z.object({
  status: z.array(z.enum(ENQUIRY_STATUSES)).max(ENQUIRY_STATUSES.length),
  band: z.array(z.enum(["comfortable", "rush", "in_stock_only"])).max(3),
});

async function handler(request: NextRequest, context: { query: z.infer<typeof Query> }) {
  const params = request.nextUrl.searchParams;
  const repeated = validate(Repeated, {
    status: params.getAll("status"),
    band: params.getAll("band"),
  });
  return Response.json(await listEnquiries({ ...context.query, ...repeated }));
}

export const GET = withPipeline(handler, { auth: "staff", rateLimit: null, query: Query });
