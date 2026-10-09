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
    await expect(page.getByText("Wedding date is required.", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Wedding date/)).toBeFocused();
  });

  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  test("shows close-date options without disabling submit", async ({ page }) => {
    await page.goto("/enquire");
    const date = page.getByLabel(/Wedding date/);
    await date.fill(inDays(6 * 7)); // rush band: between the 5-week floor and 13 weeks
    const notice = page.locator("#lead-notice");
    await expect(notice).toContainText("Planning a close date?");
    await expect(notice.getByRole("link", { name: "View gowns available now" })).toHaveAttribute(
      "href",
      "/gowns?available_now=true",
    );
    await expect(date).toHaveAttribute("aria-describedby", /lead-notice/);
    await expect(page.locator("#lead-notice[role=alert]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send enquiry" })).toBeEnabled();

    await date.fill(inDays(30 * 7)); // comfortable: no notice at all
    await expect(notice).toHaveCount(0);
    await expect(date).not.toHaveAttribute("aria-describedby", /lead-notice/);
  });

  test("a close date still sends", async ({ page }) => {
    await page.goto("/enquire");
    await page.getByLabel(/Wedding date/).fill(inDays(14)); // inside the rush floor
    await expect(page.locator("#lead-notice")).toBeVisible();
    await page.getByRole("button", { name: "Send enquiry" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  });

  test("a past date gets a plain message and is not sent", async ({ page }) => {
    let posted = false;
    page.on("request", (r) => {
      if (r.url().endsWith("/api/enquiries") && r.method() === "POST") posted = true;
    });
    await page.goto("/enquire");
    const date = page.getByLabel(/Wedding date/);
    await date.fill(inDays(-3));
    await expect(page.locator("#wedding-date-note")).toHaveText(/already passed/);
    await expect(page.locator("#lead-notice")).toHaveCount(0);
    await page.getByRole("button", { name: "Send enquiry" }).click();
    await expect(date).toBeFocused();
    expect(posted).toBe(false);
  });

  test("more than four years out asks to check the year, then sends", async ({ page }) => {
    await page.goto("/enquire");
    const date = page.getByLabel(/Wedding date/);
    await date.fill(inDays(5 * 365));
    await expect(page.locator("#wedding-date-note")).toHaveText(/check the year/);
    const send = page.getByRole("button", { name: "Send enquiry" });
    await send.click();
    await expect(page.locator("#wedding-date-note")).toHaveText(/select Send enquiry again/);
    await send.click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  });

  test("the wedding date is a required native date field (AC-ENQ-07)", async ({ page }) => {
    await page.goto("/enquire");
    const date = page.getByLabel(/Wedding date/);
    await expect(date).toHaveAttribute("type", "date");
    await expect(date).toHaveAttribute("required", "");
    const box = await date.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
