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

// KBS-89: the real server, no route mocks, JavaScript off (AC-ENQ-31).
test.describe("enquiry form without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  const future = new Date(Date.now() + 40 * 7 * 86_400_000).toISOString().slice(0, 10);

  test("a fresh visit sets kbs_csrf and the form carries the matching hidden token", async ({
    page,
    context,
  }) => {
    await page.goto("/enquire");
    const cookie = (await context.cookies()).find((c) => c.name === "kbs_csrf");
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(false);
    await expect(page.locator('input[name="csrf_token"]')).toHaveValue(cookie!.value);
  });

  test("submits natively, lands on the confirmation with only a reference", async ({ page }) => {
    const email = `nojs-${Date.now()}@kleibridal.test`;
    await page.goto("/enquire");
    await page.getByLabel("First name").fill("Maria");
    await page.getByLabel("Last name").fill("Santos");
    await page.getByLabel("Contact number").fill("+63 917 123 4567");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(/Wedding date/).fill(future);
    await page.getByLabel(/privacy notice/).check();
    await page.getByRole("button", { name: "Send enquiry" }).click();

    await expect(page).toHaveURL(
      /\/enquire\/sent\?ref=KB-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/,
    );
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
    await expect(page.locator("main")).toContainText(
      /KB-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}/,
    );
    await expect(page.locator("body")).not.toContainText(email);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("a server-side validation failure shows a readable state, not JSON", async ({ page }) => {
    await page.goto("/enquire");
    await page.getByLabel("First name").fill("Maria");
    await page.getByLabel("Last name").fill("Santos");
    await page.getByLabel("Contact number").fill("not a number");
    await page.getByLabel("Email").fill("maria@kleibridal.test");
    await page.getByLabel(/Wedding date/).fill(future);
    await page.getByLabel(/privacy notice/).check();
    await page.getByRole("button", { name: "Send enquiry" }).click();

    await expect(page).toHaveURL(/\/enquire\?error=invalid&fields=contact_number$/);
    await expect(page.getByRole("alert")).toContainText("Check: Contact number");
    expect(page.url()).not.toContain("maria");
  });

  test("a missing CSRF cookie is refused with a readable state and no JSON", async ({
    page,
    context,
  }) => {
    await page.goto("/enquire");
    await context.clearCookies();
    await page.getByLabel("First name").fill("Maria");
    await page.getByLabel("Last name").fill("Santos");
    await page.getByLabel("Contact number").fill("+63 917 123 4567");
    await page.getByLabel("Email").fill("maria@kleibridal.test");
    await page.getByLabel(/Wedding date/).fill(future);
    await page.getByLabel(/privacy notice/).check();
    await page.getByRole("button", { name: "Send enquiry" }).click();

    await expect(page).toHaveURL(/\/enquire\?error=csrf$/);
    await expect(page.getByRole("alert")).toContainText("session expired");
  });
});
