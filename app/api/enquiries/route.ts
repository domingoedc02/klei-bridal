import type { NextRequest } from "next/server";

import { PipelineError, withPipeline } from "@/server/pipeline";
import { budgets } from "@/server/ratelimit/budgets";
import {
  ENQUIRY_FORM_FIELDS,
  ENQUIRY_FORM_PATH,
  ENQUIRY_SENT_PATH,
  ENQUIRY_REFERENCE_PATTERN,
} from "@/shared/enquiryForm";
import { formRedirect } from "@/server/pipeline";
import { enquiryBodySchema, submitEnquiry, type EnquiryInput } from "@/server/services/enquiries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_request: NextRequest, context: { body?: EnquiryInput; viaForm?: boolean }) {
  if (!context.body) throw new PipelineError(400, "BAD_REQUEST", "Request body is required.");
  const { created, ...result } = await submitEnquiry(context.body);
  if (context.viaForm) {
    // New and duplicate both land on the confirmation; only a validated
    // reference ever reaches the Location header (KBS-89).
    if (!ENQUIRY_REFERENCE_PATTERN.test(result.reference)) {
      throw new Error("enquiry reference failed display validation");
    }
    return formRedirect(`${ENQUIRY_SENT_PATH}?ref=${result.reference}`);
  }
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
  // No-JS / pre-hydration native form post (decision/enquiry-nojs-csrf).
  form: {
    path: ENQUIRY_FORM_PATH,
    fields: ENQUIRY_FORM_FIELDS,
    repeatable: ["gown_ids"],
    omitEmpty: ["message"],
  },
});
