import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  hashSessionToken,
  mintSessionToken,
  sessionCookieOptions,
} from "@/server/auth/session";

describe("session token and cookie (KBS-27-1)", () => {
  it("mints 256 random bits as 43 base64url characters, never the same twice", () => {
    const a = mintSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(mintSessionToken()).not.toBe(a);
  });

  it("stores a SHA-256 hex digest, not the token", () => {
    const token = mintSessionToken();
    const digest = hashSessionToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
  });

  it("sets kbs_session HttpOnly; Secure; SameSite=Lax; Path=/, host-only, Max-Age = expiry", () => {
    const now = new Date("2026-10-09T00:00:00Z");
    const expires = new Date(now.getTime() + 14 * 86_400_000);
    const opts = sessionCookieOptions(expires, now);
    expect(SESSION_COOKIE).toBe("kbs_session");
    expect(opts).toEqual({
      httpOnly: true,
      secure: true, // NODE_ENV=test — only `next dev` turns it off
      sameSite: "lax",
      path: "/",
      maxAge: 14 * 86_400,
    });
    expect(opts).not.toHaveProperty("domain");
    expect(clearedSessionCookieOptions().maxAge).toBe(0);
  });
});
