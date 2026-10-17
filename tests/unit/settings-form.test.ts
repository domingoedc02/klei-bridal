import { describe, expect, it } from "vitest";

import { validateSettingsForm, type AdminSettingsForm } from "@/components/admin/SettingsForm";

const valid: AdminSettingsForm = {
  lead_time_comfortable_weeks: 13,
  lead_time_rush_floor_weeks: 5,
  lead_time_notice_copy: {
    comfortable: "We can make your gown in our usual window.",
    rush: "Ask us about rush production.",
    in_stock_only: "Only in-stock gowns can be guaranteed in time.",
  },
  studio_timezone: "Asia/Manila",
  studio_facebook_page: "klei.bridal",
  studio_whatsapp_number: "639171234567",
  studio_viber_number: "639171234567",
};

describe("settings form validation", () => {
  it("accepts valid lead-time and notice values", () => {
    expect(validateSettingsForm(valid)).toBeNull();
  });

  it("requires rush floor below comfortable window", () => {
    expect(validateSettingsForm({ ...valid, lead_time_rush_floor_weeks: 13 })).toContain("less than");
  });

  it("rejects blank notice copy", () => {
    expect(validateSettingsForm({
      ...valid,
      lead_time_notice_copy: { ...valid.lead_time_notice_copy, rush: " " },
    })).toContain("Each notice");
  });
});
