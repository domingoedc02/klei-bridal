import { describe, expect, it } from "vitest";

import {
  gownFilterQuerySchema,
  gownFilterQueryString,
} from "../../src/shared/schemas/gownFilters";

describe("gownFilterQuerySchema", () => {
  it("normalizes repeatable URL filters and blank bounds", () => {
    expect(
      gownFilterQuerySchema.parse({
        q: "  lace  ",
        material: ["lace", "lace", "satin"],
        price_min: "",
        price_max: "85000",
        available: "1",
      }),
    ).toMatchObject({
      q: "lace",
      material: ["lace", "satin"],
      price_min: undefined,
      price_max: 85000,
      available: "1",
      sort: "newest",
      page: 1,
    });
  });

  it("serializes normalized state in stable URL order", () => {
    const query = gownFilterQuerySchema.parse({
      material: ["satin", "lace"],
      collection: "new-arrivals",
      available: "1",
      price_max: "85000",
      page: "2",
    });
    expect(gownFilterQueryString(query)).toBe(
      "material=lace&material=satin&collection=new-arrivals&available=1&price_max=85000&page=2",
    );
  });

  it("rejects invalid availability, bounds, sort and unknown keys", () => {
    for (const value of [
      { available: "true" },
      { price_min: "12.5" },
      { price_min: "1e3" },
      { price_min: "+100" },
      { price_min: " 100 " },
      { price_min: "90", price_max: "80" },
      { sort: "popular" },
      { unexpected: "value" },
    ]) {
      expect(() => gownFilterQuerySchema.parse(value)).toThrow();
    }
  });
});
