import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn(),
  confirmStaffInvite: vi.fn(),
  validateSession: vi.fn(),
  hit: vi.fn(),
  counts: new Map<string, number>(),
}));

vi.mock("@/server/services/password-reset", () => ({
  confirmPasswordReset: mocks.confirmPasswordReset,
  confirmStaffInvite: mocks.confirmStaffInvite,
}));

vi.mock("@/server/auth/session", () => ({
  SESSION_COOKIE: "kbs_session",
  SESSION_TOKEN_PATTERN: /^[A-Za-z0-9_-]{43}$/,
  validateSession: mocks.validateSession,
}));

vi.mock("@/server/ratelimit", () => ({
  getRateLimitStore: () => ({ hit: mocks.hit }),
  getValkeyClient: () => ({}),
}));

import { env } from "@/config/env";
import { mintCsrfToken } from "@/server/pipeline";
import { GET, POST } from "../../../app/api/auth/password-reset/confirm/route";

/** `duplex` is required by undici for a stream body but missing from Next typings. */
type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

const TOKEN = "A".repeat(43);
const PASSWORD = "a-real-reset-password-42";

function post(
  body: unknown = { token: TOKEN, new_password: PASSWORD },
  ip = "203.0.113.9",
): NextRequest {
  const csrf = mintCsrfToken();
  return new NextRequest(`${env.SITE_URL}/api/auth/password-reset/confirm`, {
    method: "POST",
    headers: {
      origin: new URL(env.SITE_URL).origin,
      cookie: `kbs_csrf=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
    duplex: "half",
  } as NextRequestInit);
}

beforeEach(() => {
  mocks.confirmPasswordReset.mockReset();
  mocks.confirmStaffInvite.mockReset().mockResolvedValue({ ok: false, reason: "invalid_token" });
  mocks.validateSession.mockReset().mockResolvedValue(null);
  mocks.hit.mockReset().mockImplementation(async (key: string, windowSec: number) => {
    const count = (mocks.counts.get(key) ?? 0) + 1;
    mocks.counts.set(key, count);
    return { count, ttlSec: windowSec };
  });
  mocks.counts.clear();
});

describe("GET /api/auth/password-reset/confirm", () => {
  it("bootstraps the CSRF cookie on a first visit", async () => {
    const response = await GET(
      new NextRequest(`${env.SITE_URL}/api/auth/password-reset/confirm`, { method: "GET" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("kbs_csrf=");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/auth/password-reset/confirm", () => {
  it("maps an invalid or expired token to 400 without leaking token details", async () => {
    mocks.confirmPasswordReset.mockResolvedValue({ ok: false, reason: "invalid_token" });

    const response = await POST(post());
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("RESET_TOKEN_INVALID");
    expect(body.error.message).toBe("This reset link is invalid or has expired.");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(mocks.confirmPasswordReset).toHaveBeenCalledOnce();
  });

  it("rejects malformed token and password before calling reset service", async () => {
    const response = await POST(post({ token: "not-a-token", new_password: "short" }));
    const body = (await response.json()) as { error: { code: string; fields?: unknown } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toBeDefined();
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it("uses staff-invite-redemption IP budget: three requests pass, fourth is 429", async () => {
    mocks.confirmPasswordReset.mockResolvedValue({ ok: true, revokedSessions: 1 });

    const responses: Response[] = [];
    for (let index = 0; index < 4; index += 1) responses.push(await POST(post()));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
    expect(mocks.hit).toHaveBeenCalledWith("rl:staff-invite-redemption:ip:203.0.113.9", 900);
    expect(mocks.confirmPasswordReset).toHaveBeenCalledTimes(3);
    expect(Number(responses[3]!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
