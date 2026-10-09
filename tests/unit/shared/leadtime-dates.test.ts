import { describe, expect, it } from "vitest";

import { enquiryBodySchema, newReference } from "@/server/services/enquiries";
import { daysBetween, isIsoDate, todayIn } from "@/shared/dates";
import { leadTimeBand } from "@/shared/leadtime";

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("dates", () => {
  it("validates strict calendar dates", () => {
    expect(isIsoDate("2027-06-12")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    for (const bad of ["2027-02-30", "2027-6-12", "2027-06-12T00:00", "12/06/2027", ""]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });

  it("takes today in the studio timezone, not UTC", () => {
    // 2026-10-09T17:30Z is already 2026-10-10 01:30 in Manila (UTC+8).
    const now = new Date("2026-10-09T17:30:00Z");
    expect(todayIn("Asia/Manila", now)).toBe("2026-10-10");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-10-09");
  });

  it("counts whole days across a DST change", () => {
    expect(daysBetween("2027-03-01", "2027-04-01")).toBe(31);
    expect(daysBetween("2027-04-01", "2027-03-01")).toBe(-31);
  });
});

describe("leadTimeBand — AC-ENQ-13 boundary sweep", () => {
  const today = "2026-10-09";
  const at = (weeks: number, days = 0) => addDays(today, weeks * 7 + days);

  it("matches the AC catalogue with its floor of 8", () => {
    const rule = { comfortableWeeks: 13, rushFloorWeeks: 8 };
    const sweep: Array<[string, string]> = [
      [at(7, 6), "in_stock_only"],
      [at(8, 0), "in_stock_only"],
      [at(8, 1), "rush"],
      [at(12, 6), "rush"],
      [at(13, 0), "comfortable"],
      [at(13, 1), "comfortable"],
    ];
    for (const [date, band] of sweep) expect(leadTimeBand(date, today, rule)).toBe(band);
  });

  it("uses the confirmed seed (13/5)", () => {
    const rule = { comfortableWeeks: 13, rushFloorWeeks: 5 };
    expect(leadTimeBand(at(40), today, rule)).toBe("comfortable");
    expect(leadTimeBand(at(10), today, rule)).toBe("rush");
    expect(leadTimeBand(at(3), today, rule)).toBe("in_stock_only");
    expect(leadTimeBand(today, today, rule)).toBe("in_stock_only");
  });
});

describe("display reference — decision/enquiry-link AC 7", () => {
  it("is KB-XXXX-XXXX with no 0 O 1 I L, and not sequential", () => {
    const refs = new Set(Array.from({ length: 500 }, newReference));
    expect(refs.size).toBe(500);
    for (const r of refs) {
      expect(r).toMatch(/^KB-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(r.slice(3)).not.toMatch(/[01OIL]/);
    }
  });
});

describe("enquiryBodySchema", () => {
  const base = {
    first_name: "Maricel",
    last_name: "Santos",
    contact_number: "+63 917 123 4567",
    email: "maricel@example.com",
    wedding_date: "2027-06-12",
  };

  it("accepts international numbers as typed (AC-ENQ-27)", () => {
    for (const n of [
      "+63 917 123 4567",
      "09171234567",
      "+971 50 123 4567",
      "+1 (415) 555-0132",
      "+44 7700 900123",
      "+81 90-1234-5678",
    ]) {
      const parsed = enquiryBodySchema.safeParse({ ...base, contact_number: n });
      expect(parsed.success && parsed.data.contact_number).toBe(n);
    }
  });

  it("rejects bad numbers (AC-ENQ-28)", () => {
    for (const n of ["abc", "", "1".repeat(400), "<script>alert(1)</script>"]) {
      expect(enquiryBodySchema.safeParse({ ...base, contact_number: n }).success).toBe(false);
    }
  });

  it("strips a forged source and dedupes gown ids", () => {
    const id = "0192f0a0-0000-7000-8000-000000000001";
    const parsed = enquiryBodySchema.parse({
      ...base,
      source: "social",
      utm_source: "x",
      gown_ids: [id, id.toUpperCase()],
    });
    expect(parsed).not.toHaveProperty("source");
    expect(parsed).not.toHaveProperty("utm_source");
    expect(parsed.gown_ids).toEqual([id]);
  });

  it("rejects HTML in names, malformed ids and over 50 ids (AC-ENQ-19/20)", () => {
    expect(enquiryBodySchema.safeParse({ ...base, first_name: "<b>x</b>" }).success).toBe(false);
    for (const bad of ["' OR 1=1 --", "../../etc/passwd", "x".repeat(1_000_000), null, { a: 1 }]) {
      expect(enquiryBodySchema.safeParse({ ...base, gown_ids: [bad] }).success).toBe(false);
    }
    const many = Array.from(
      { length: 51 },
      (_, i) => `0192f0a0-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(enquiryBodySchema.safeParse({ ...base, gown_ids: many }).success).toBe(false);
  });
});
