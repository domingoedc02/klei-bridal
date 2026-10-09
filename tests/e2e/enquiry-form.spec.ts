import { expect, test } from "@playwright/test";

test.describe("enquiry form", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("kbs.favourites.v1", JSON.stringify(["gown-001", "gown-002"]));
      localStorage.setItem(
        "kbs.contact.v1",
        JSON.stringify({
          firstName: "Maria",
          lastName: "Santos",
          contactNumber: "+63 917 123 4567",
          email: "maria@example.com",
        }),
      );
    });
    await page.route("**/api/enquiries", async (route) => {
      if (route.request().method() === "POST")
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ reference: "ENQ-1" }),
        });
      else await route.continue();
    });
  });

  test("prefills contact and removes selected gowns", async ({ page }) => {
    await page.goto("/enquire");
    await expect(page.getByLabel("First name")).toHaveValue("Maria");
    await expect(page.getByText("gown-001")).toBeVisible();
    await page.getByRole("button", { name: "Remove gown gown-001" }).click();
    await expect(page.getByText("gown-001")).not.toBeVisible();
  });

  test("requires date and focuses date", async ({ page }) => {
    await page.goto("/enquire");
    await page.getByRole("button", { name: "Send enquiry" }).click();
    await expect(page.getByRole("alert")).toContainText("Wedding date is required");
    await expect(page.getByLabel(/Wedding date/)).toBeFocused();
  });

  test("shows close-date options without disabling submit", async ({ page }) => {
    await page.goto("/enquire");
    const date = new Date(Date.now() + 6 * 7 * 86400000).toISOString().slice(0, 10);
    await page.getByLabel(/Wedding date/).fill(date);
    await expect(page.getByText(/In-stock gowns and rush orders/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send enquiry" })).toBeEnabled();
  });
});
