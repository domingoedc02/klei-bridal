import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { MIN_PASSWORD_LENGTH } from "@/server/services/auth";
import { budgets } from "@/server/ratelimit/budgets";
import { clientIp } from "@/server/ratelimit/client-ip";
import { PipelineError, withPipeline } from "@/server/pipeline";
import { confirmPasswordReset, confirmStaffInvite } from "@/server/services/password-reset";
import { isCrossOrigin } from "@/server/services/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ConfirmBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Reset link is invalid."),
  new_password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(1024),
});

async function handler(request: NextRequest, context: { body: z.infer<typeof ConfirmBody> }) {
  if (isCrossOrigin(request.headers)) {
    throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
  }

  const input = {
    token: context.body.token,
    newPassword: context.body.new_password,
    ip: clientIp(request.headers),
    userAgent: request.headers.get("user-agent"),
  };
  const invite = await confirmStaffInvite(input);
  const result =
    !invite.ok && invite.reason === "invalid_token" ? await confirmPasswordReset(input) : invite;

  if (!result.ok) {
    switch (result.reason) {
      case "invalid_token":
        throw new PipelineError(
          400,
          "RESET_TOKEN_INVALID",
          "This reset link is invalid or has expired.",
        );
      case "weak_password":
        throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
          fields: { new_password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
        });
      case "password_too_common":
        throw new PipelineError(422, "PASSWORD_TOO_COMMON", "Choose a less common password.", {
          fields: { new_password: "Choose a less common password." },
        });
      case "unavailable":
        throw new PipelineError(
          503,
          "SERVICE_UNAVAILABLE",
          "Password reset is temporarily unavailable. Try again shortly.",
          {
            retryAfterSec: 30,
          },
        );
    }
  }

  return NextResponse.json(
    { ok: true, revoked_sessions: result.revokedSessions },
    {
      status: 200,
      headers: { "cache-control": "no-store" },
    },
  );
}

export const GET = withPipeline(
  () => NextResponse.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store" } }),
  { auth: "public", rateLimit: null },
);

export const POST = withPipeline(handler, {
  auth: "public",
  rateLimit: budgets.staffInviteRedemption,
  body: ConfirmBody,
});
