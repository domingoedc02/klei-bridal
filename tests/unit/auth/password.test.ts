import { describe, expect, it } from "vitest";

import {
  ARGON2_PARAMS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "@/server/auth/password";

describe("argon2id password hashing (KBS-27-1)", () => {
  it("hashes with argon2id at the documented parameters", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}\\$`,
      ),
    );
    expect(await verifyPassword(stored, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(stored, "wrong")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  // The dummy must cost exactly what a real verify costs, or an unknown
  // email is faster than a wrong password and timing enumerates accounts.
  it("pins the dummy hash to the same parameters as real hashes", async () => {
    const real = await hashPassword("x");
    const params = (h: string) => h.split("$")[3];
    expect(params(DUMMY_PASSWORD_HASH)).toBe(params(real));
    expect(await verifyPassword(DUMMY_PASSWORD_HASH, "anything")).toBe(false);
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
