import type { NextRequest } from "next/server";

import { PipelineError, withPipeline } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import { enquiryBodySchema, submitEnquiry, type EnquiryInput } from "@/server/services/enquiries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_request: NextRequest, context: { body?: EnquiryInput }) {
  if (!context.body) throw new PipelineError(400, "BAD_REQUEST", "Request body is required.");
  const { created, ...result } = await submitEnquiry(context.body);
  // 201 for a new enquiry; 200 with her existing reference for a duplicate
  // inside the window — never an error (AC-ENQ-25).
  return Response.json(result, {
    status: created ? 201 : 200,
    headers: { "cache-control": "no-store" },
  });
}

// Public, CSRF on (pipeline default), 5/10 min/IP, fails closed without Valkey.
export const POST = withPipeline(handler, {
  auth: "public",
  rateLimit: budgets.enquirySubmit,
  body: enquiryBodySchema,
});
