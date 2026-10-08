import { afterEach, describe, expect, it } from "vitest";
import {
  assertPasswordAllowed,
  resetPasswordPolicyCacheForTests,
  setPasswordPolicyListPathForTests,
} from "@/server/auth/password-policy";

afterEach(() => {
  resetPasswordPolicyCacheForTests();
});

describe("password policy", () => {
  it("rejects listed, email-derived and short passwords", async () => {
    await expect(
      assertPasswordAllowed("Password123!", { email: "bride@example.com" }),
    ).resolves.toEqual({ ok: false, reason: "password_too_common" });
    await expect(
      assertPasswordAllowed("brideLongPass!", { email: "bride@example.com" }),
    ).resolves.toEqual({ ok: false, reason: "password_too_common" });
    await expect(assertPasswordAllowed("short")).resolves.toEqual({
      ok: false,
      reason: "weak_password",
    });
  });

  it("accepts a long random passphrase", async () => {
    await expect(assertPasswordAllowed("Violet river lantern 74!x")).resolves.toEqual({ ok: true });
  });

  it("rejects required normalized common passwords", async () => {
    await expect(assertPasswordAllowed("Password123!")).resolves.toEqual({
      ok: false,
      reason: "password_too_common",
    });
    await expect(assertPasswordAllowed("kleibridal2026")).resolves.toEqual({
      ok: false,
      reason: "password_too_common",
    });
  });

  it("fails closed when list is unavailable", async () => {
    setPasswordPolicyListPathForTests("/missing/common-passwords.txt.gz");
    await expect(assertPasswordAllowed("Violet river lantern 74!x")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
