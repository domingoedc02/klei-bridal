import { describe, expect, it } from "vitest";

import { adminSettingsPatchSchema } from "@/server/services/admin-settings";

const notice = {
  comfortable: "",
  rush: "Ask us about rush production and in-stock gowns.",
  in_stock_only: "Only in-stock gowns can be guaranteed in time.",
};

describe("admin settings patch validation", () => {
  it("accepts bounded lead-time and contact settings", () => {
    const result = adminSettingsPatchSchema.safeParse({
      lead_time_comfortable_weeks: 20,
      lead_time_rush_floor_weeks: 5,
      lead_time_notice_copy: { ...notice, comfortable: "Comfortable timing." },
      studio_timezone: "Asia/Manila",
      studio_facebook_page: "klei.bridal",
      studio_whatsapp_number: "639171234567",
      studio_viber_number: "639171234567",
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty notice copy and malformed contact values", () => {
    expect(
      adminSettingsPatchSchema.safeParse({
        lead_time_notice_copy: { ...notice, rush: "" },
      }).success,
    ).toBe(false);
    expect(
      adminSettingsPatchSchema.safeParse({ studio_timezone: "Not/AZone" }).success,
    ).toBe(false);
    expect(
      adminSettingsPatchSchema.safeParse({ studio_facebook_page: "bad handle" }).success,
    ).toBe(false);
    expect(
      adminSettingsPatchSchema.safeParse({ studio_whatsapp_number: "abc" }).success,
    ).toBe(false);
  });

  it("rejects unknown and empty patches", () => {
    expect(adminSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(adminSettingsPatchSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
