import { NextResponse } from "next/server";
import { z } from "zod";

import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/server/auth/password";
import { budgets } from "@/server/ratelimit/budgets";
import { withPipeline } from "@/server/pipeline";
import { requestPasswordReset } from "@/server/services/password-reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestBody = z.object({
  email: z.string().trim().email().max(320),
});

const ACCEPTED_MESSAGE = "If an active staff account matches, reset instructions will be sent.";

async function handler(_request: Request, context: { body: z.infer<typeof RequestBody> }) {
  // Every path pays one full password verification before account-specific
  // work. This keeps an account lookup from becoming a useful timing oracle.
  await verifyPassword(DUMMY_PASSWORD_HASH, context.body.email);
  await requestPasswordReset({ email: context.body.email });

  return NextResponse.json(
    { ok: true, message: ACCEPTED_MESSAGE },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}

export const POST = withPipeline(handler, {
  auth: "public",
  rateLimit: budgets.passwordResetRequest,
  body: RequestBody,
});
