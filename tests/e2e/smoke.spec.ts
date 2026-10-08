import { expect, test } from "@playwright/test";

// Smoke: the production build boots and serves its public shell at both
// review widths. Feature journeys (catalogue, gown page, favourites,
// enquiry) add their own specs here as those stories land.

test("home renders the studio name", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Klei Bridal Studio/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Klei Bridal Studio");
});

test("home does not scroll horizontally", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("unknown route returns the not-found page with a 404", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
});
