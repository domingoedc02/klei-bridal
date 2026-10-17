import { expect, test } from "@playwright/test";

test("privacy notice states host, region, retention; caveat is separate (KBS-30)", async ({ page }) => {
  await page.goto("/privacy");
  const main = page.getByRole("main");
  await expect(main).toContainText("Hostinger server in Singapore");
  await expect(main).toContainText("stay on your phone");
  await expect(page.getByRole("heading", { name: /status of this notice/ })).toBeVisible();
  await expect(page.locator("hr")).toHaveCount(1);
  await expect(main).not.toContainText(/\bTBD\b/);
});

test("the enquiry form links to the notice and refuses without ticking", async ({ page }) => {
  await page.goto("/enquire");
  await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
  await expect(page.getByLabel(/privacy notice/)).toHaveAttribute("required", "");
});
