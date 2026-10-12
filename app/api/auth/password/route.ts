import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clientIp } from "@/server/ratelimit/client-ip";
import { budgets } from "@/server/ratelimit/budgets";
import { MIN_PASSWORD_LENGTH, changePassword } from "@/server/services/auth";
import { isCrossOrigin } from "@/server/services/auth-http";
import { PipelineError, withPipeline } from "@/server/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChangePasswordBody = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(1024),
});

async function handler(request: NextRequest) {
  if (isCrossOrigin(request.headers)) {
    throw new PipelineError(403, "FORBIDDEN", "Cross-site request refused.");
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch (error) {
    throw new PipelineError(400, "BAD_REQUEST", "Request body must be JSON.", { cause: error });
  }

  const parsed = ChangePasswordBody.safeParse(json);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "body";
      fields[key] ??= issue.message;
    }
    throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", { fields });
  }

  const result = await changePassword({
    token: request.cookies.get(SESSION_COOKIE)?.value,
    currentPassword: parsed.data.current_password,
    newPassword: parsed.data.new_password,
    ip: clientIp(request.headers),
    userAgent: request.headers.get("user-agent"),
  });

  if (!result.ok) {
    switch (result.reason) {
      case "unauthenticated":
        throw new PipelineError(401, "UNAUTHENTICATED", "Sign in again to continue.");
      case "wrong_current_password":
        throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
          fields: { current_password: "Current password is incorrect." },
        });
      case "same_password":
        throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
          fields: { new_password: "New password must differ from current password." },
        });
      case "weak_password":
        throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
          fields: { new_password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
        });
      case "password_too_common":
        throw new PipelineError(422, "PASSWORD_TOO_COMMON", "Choose a less common password.", {
          fields: { new_password: "Choose a less common password." },
        });
      case "too_many_attempts": {
        const minutes = Math.ceil(result.retryAfterSeconds / 60);
        throw new PipelineError(
          429,
          "TOO_MANY_ATTEMPTS",
          `Too many wrong current passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          { retryAfterSec: result.retryAfterSeconds },
        );
      }
      case "unavailable":
        throw new PipelineError(
          503,
          "SERVICE_UNAVAILABLE",
          "Password change is temporarily unavailable. Try again shortly.",
          { retryAfterSec: 30 },
        );
    }
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  response.headers.set("cache-control", "no-store");
  return response;
}

export const POST = withPipeline(handler, {
  auth: "staff",
  rateLimit: budgets.adminWrite,
  allowPendingPasswordChange: true,
});
