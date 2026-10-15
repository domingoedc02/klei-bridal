import { describe, expect, it } from "vitest";

import { derivativePaths } from "@/server/media/variants";
import { missingDerivativePaths } from "@/server/media/derivativeVerification";

const originalPath = "ab/cd/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg";

describe("image verification command contract", () => {
  it("reports every missing derivative instead of passing", () => {
    const missing = missingDerivativePaths([{ originalPath }], new Set());
    expect(missing).toEqual(derivativePaths(originalPath));
  });

  it("passes one image only when all derivatives exist", () => {
    const present = new Set(derivativePaths(originalPath));
    expect(missingDerivativePaths([{ originalPath }], present)).toEqual([]);
  });
});
