import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clientIp } from "@/server/ratelimit/client-ip";
import { signIn } from "@/server/services/auth";
import { isCrossOrigin } from "@/server/services/auth-http";
import { PipelineError, withPipeline } from "@/server/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
});

const INVALID_MESSAGE = "Invalid email or password.";

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

  const parsed = LoginBody.safeParse(json);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "body";
      fields[key] ??= issue.message;
    }
    throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", { fields });
  }

  const result = await signIn({
    email: parsed.data.email,
    password: parsed.data.password,
    ip: clientIp(request.headers),
    userAgent: request.headers.get("user-agent"),
  });

  if (!result.ok) {
    switch (result.reason) {
      case "invalid_credentials":
        throw new PipelineError(401, "INVALID_CREDENTIALS", INVALID_MESSAGE);
      case "account_locked": {
        const minutes = Math.ceil(result.retryAfterSeconds / 60);
        throw new PipelineError(
          429,
          "ACCOUNT_LOCKED",
          `Too many failed sign-in attempts for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          { retryAfterSec: result.retryAfterSeconds },
        );
      }
      case "ip_rate_limited":
        throw new PipelineError(
          429,
          "RATE_LIMITED",
          "Too many sign-in attempts from this network. Try again later.",
          { retryAfterSec: result.retryAfterSeconds },
        );
      case "unavailable":
        throw new PipelineError(
          503,
          "SERVICE_UNAVAILABLE",
          "Sign-in is temporarily unavailable. Try again shortly.",
          { retryAfterSec: result.retryAfterSeconds },
        );
    }
  }

  const response = NextResponse.json(
    { password_change_required: result.passwordChangeRequired },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  response.headers.set("cache-control", "no-store");
  return response;
}

export const POST = withPipeline(handler, { auth: "public", rateLimit: null });
