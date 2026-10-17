import { describe, expect, it } from "vitest";

import {
  buildDashboard,
  dashboardQuerySchema,
  resolveDashboardRange,
} from "@/server/services/admin-dashboard";

describe("admin dashboard", () => {
  it("defaults to current and previous month and bounds ranges", () => {
    const range = resolveDashboardRange({}, new Date("2026-10-17T12:00:00Z"));
    expect(range.months).toEqual(["2026-09", "2026-10"]);
    expect(() => resolveDashboardRange({ from: "2020-01", to: "2023-01" })).toThrow(
      "cannot exceed",
    );
  });

  it("requires a complete bounded month query", () => {
    expect(dashboardQuerySchema.safeParse({ from: "2026-01" }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: "2026-13", to: "2026-14" }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: "2026-03", to: "2026-01" }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: "2026-01", to: "2026-03" }).success).toBe(true);
  });

  it("maps null chat to none and does not invent send-list analytics", () => {
    const body = buildDashboard(
      resolveDashboardRange({ from: "2026-10", to: "2026-11" }),
      [{ month: "2026-10", value: 2 }],
      [{ month: "2026-10", key: "social", value: 2 }],
      [{ month: "2026-10", key: null, value: 2 }],
      [{ gownId: "gown-1", gownName: "Aster", value: 2 }],
    );

    expect(body.months[0]).toMatchObject({
      enquiry_count: 2,
      source_split: { social: 2, search: 0, direct: 0, referral: 0 },
      chat_channel_split: { messenger: 0, whatsapp: 0, viber: 0, none: 2 },
    });
    expect(body.send_my_list_sends).toEqual({
      available: false,
      count: null,
      reason: expect.stringContaining("event table"),
    });
    expect(body.most_requested_gowns).toEqual([
      { gown_id: "gown-1", gown_name: "Aster", request_count: 2 },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/first_name|last_name|email|phone|message/);
  });
});
