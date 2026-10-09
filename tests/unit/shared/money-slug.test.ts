import { describe, expect, it } from "vitest";
import { formatMinor, parsePriceToMinor } from "../../../src/shared/money";
import { slugify } from "../../../src/shared/slug";

describe("parsePriceToMinor", () => {
  it.each([
    ["₱45,000.00", 4_500_000],
    ["45000", 4_500_000],
    ["PHP 45,000.5", 4_500_050],
    ["1,250,000.99", 125_000_099],
  ])("%s → %d", (input, minor) => expect(parsePriceToMinor(input)).toBe(minor));

  it.each(["", "0", "-500", "12.345", "1.2.3", "abc"])("rejects %j", (input) =>
    expect(parsePriceToMinor(input)).toBeNull(),
  );
});

describe("formatMinor", () => {
  it("shows the ISO code and two decimals", () => {
    expect(formatMinor(4_500_000)).toBe("PHP 45,000.00");
    expect(formatMinor(125_000_099)).toBe("PHP 1,250,000.99");
  });
  it("round-trips through the parser", () =>
    expect(parsePriceToMinor(formatMinor(4_500_050))).toBe(4_500_050));
});

describe("slugify", () => {
  it("lowercases, strips accents and punctuation", () =>
    expect(slugify("  Amélie Ball Gown! ")).toBe("amelie-ball-gown"));
  it("returns empty for symbol-only names", () => expect(slugify("₱ — !")).toBe(""));
});
