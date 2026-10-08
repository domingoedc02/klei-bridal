import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, sessionCookieOptions } from "@/server/auth/session";
import { clientIp } from "@/server/ratelimit/client-ip";
import { MIN_PASSWORD_LENGTH, changePassword } from "@/server/services/auth";
import { errorResponse, isCrossOrigin, requestIdOf } from "@/server/services/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChangePasswordBody = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(1024),
});

/**
 * POST /api/auth/password — { current_password, new_password } → 204 and
 * a NEW `kbs_session` cookie. Every other session of the account is
 * revoked, and this one is rotated: the cookie sent with this request is
 * dead once the response is written (KBS-27-2).
 */
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

  const parsed = ChangePasswordBody.safeParse(json);
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
        return errorResponse(401, "UNAUTHENTICATED", "Sign in again to continue.", requestId);
      case "wrong_current_password":
        return errorResponse(422, "VALIDATION_ERROR", "Check the highlighted fields.", requestId, {
          fields: { current_password: "Current password is incorrect." },
        });
      case "weak_password":
        return errorResponse(422, "VALIDATION_ERROR", "Check the highlighted fields.", requestId, {
          fields: { new_password: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
        });
    }
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt));
  response.headers.set("cache-control", "no-store");
  return response;
}
