import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clientIp } from "@/server/ratelimit/client-ip";
import { signIn } from "@/server/services/auth";
import { errorResponse, isCrossOrigin, requestIdOf } from "@/server/services/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z.string().trim().email().max(320),
  // Upper bound so a megabyte "password" cannot be fed to argon2.
  password: z.string().min(1).max(1024),
});

// One message for unknown email, wrong password and disabled account —
// any difference is an enumeration oracle (KBS-27-1).
const INVALID_MESSAGE = "Invalid email or password.";

/** POST /api/auth/login — { email, password } → 204 + `kbs_session` cookie. */
export async function POST(request: NextRequest) {
  const requestId = requestIdOf(request.headers);

  if (isCrossOrigin(request.headers)) {
    return errorResponse(403, "FORBIDDEN", "Cross-site request refused.", requestId);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return errorResponse(400, "BAD_REQUEST", "Request body must be JSON.", requestId);
  }

  const parsed = LoginBody.safeParse(json);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "body";
      fields[key] ??= issue.message;
    }
    return errorResponse(422, "VALIDATION_ERROR", "Check the highlighted fields.", requestId, {
      fields,
    });
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
        return errorResponse(401, "INVALID_CREDENTIALS", INVALID_MESSAGE, requestId);
      case "account_locked": {
        const minutes = Math.ceil(result.retryAfterSeconds / 60);
        return errorResponse(
          429,
          "ACCOUNT_LOCKED",
          `Too many failed sign-in attempts for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
          requestId,
          { retryAfterSeconds: result.retryAfterSeconds },
        );
      }
      case "ip_rate_limited":
        return errorResponse(
          429,
          "RATE_LIMITED",
          "Too many sign-in attempts from this network. Try again later.",
          requestId,
          { retryAfterSeconds: result.retryAfterSeconds },
        );
      case "unavailable":
        return errorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Sign-in is temporarily unavailable. Try again shortly.",
          requestId,
          { retryAfterSeconds: result.retryAfterSeconds },
        );
    }
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  response.headers.set("cache-control", "no-store");
  return response;
}
