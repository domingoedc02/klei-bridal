import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookieValue, validateSession, redirect } = vi.hoisted(() => ({
  cookieValue: vi.fn<() => { value?: string } | undefined>(),
  validateSession: vi.fn(),
  redirect: vi.fn((location: string): never => {
    throw new Error(`REDIRECT:${location}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookieValue }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/server/auth/session", () => ({
  SESSION_COOKIE: "kbs_session",
  validateSession,
}));
vi.mock("@/server/db/client", () => ({ db: {} }));

import { requireStaffPage } from "@/server/auth/page-session";

describe("requireStaffPage", () => {
  beforeEach(() => {
    cookieValue.mockReset();
    validateSession.mockReset();
    redirect.mockClear();
  });

  it("redirects unauthenticated requests before page data can load", async () => {
    cookieValue.mockReturnValue(undefined);
    validateSession.mockResolvedValue(null);

    await expect(requireStaffPage()).rejects.toThrow("REDIRECT:/admin/login");
    expect(redirect).toHaveBeenCalledWith("/admin/login");
    expect(validateSession).toHaveBeenCalledOnce();
  });

  it("redirects pending password sessions before page data can load", async () => {
    cookieValue.mockReturnValue({ value: "session-token" });
    validateSession.mockResolvedValue({
      sessionId: "session-id",
      expiresAt: new Date("2030-01-01"),
      staff: { id: "staff-id", name: "Staff", email: "staff@example.test" },
      passwordChangeRequired: true,
    });

    await expect(requireStaffPage()).rejects.toThrow("REDIRECT:/admin/change-password");
    expect(redirect).toHaveBeenCalledWith("/admin/change-password");
  });

  it("returns active principal after session validation", async () => {
    const principal = {
      sessionId: "session-id",
      expiresAt: new Date("2030-01-01"),
      staff: { id: "staff-id", name: "Staff", email: "staff@example.test" },
      passwordChangeRequired: false,
    };
    cookieValue.mockReturnValue({ value: "session-token" });
    validateSession.mockResolvedValue(principal);

    await expect(requireStaffPage()).resolves.toEqual(principal);
    expect(validateSession).toHaveBeenCalledWith({}, "session-token");
    expect(redirect).not.toHaveBeenCalled();
  });
});
