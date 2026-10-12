import type { NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/config/env";
import { readMultipart, withPipeline, type Principal } from "@/server/pipeline";
import { defaultBodyLimits } from "@/server/pipeline/body-limit";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { addGownImages, listGownImages } from "@/server/services/admin-gown-images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Params = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }>; principal: Principal };

// The stream cap and the per-file/count checks both come from env.ts.
const limits = {
  ...defaultBodyLimits,
  multipartFileBytes: env.IMAGE_MAX_UPLOAD_BYTES,
  multipartFiles: env.IMAGE_MAX_PER_GOWN,
};

async function handler(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const form = await readMultipart(request, limits);
  // File names and client MIME types are never read past this line.
  const files = [...form.values()].filter((v): v is File => v instanceof File);
  const result = await addGownImages(id, files, context.principal, clientIp(request.headers));
  return Response.json(result, { status: 201 });
}

export const POST = withPipeline(handler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  params: Params,
  bodyLimits: limits,
});

async function getHandler(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  return Response.json(await listGownImages(id));
}

// Polled while encodes drain; a read, so no write budget (same as GET /admin/gowns/:id).
export const GET = withPipeline(getHandler, { auth: "staff", rateLimit: null, params: Params });
