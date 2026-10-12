import { describe, expect, it } from "vitest";

import { precheck } from "@/components/admin/GownImages";

const file = (type: string, size: number) => new File([new Uint8Array(size)], "x", { type });

describe("GownImages precheck (KBS-21-5)", () => {
  it("passes JPEG/PNG/WebP and type-less files (HEIC often has none); server decides", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", ""])
      expect(precheck(file(type, 10), 100)).toBeNull();
  });
  it("refuses other types and oversize files with the limit", () => {
    expect(precheck(file("application/pdf", 10), 100)).toBe("Upload a JPEG, PNG or WebP photo.");
    expect(precheck(file("image/jpeg", 3_000_000), 2_097_152)).toBe("Larger than 2 MB.");
  });
});
