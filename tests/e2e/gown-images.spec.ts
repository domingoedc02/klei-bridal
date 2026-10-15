import { expect, test } from "@playwright/test";

const widths = [320, 480, 768, 1024, 1440, 2048];
const fixtureSlug = process.env.E2E_GOWN_SLUG ?? "sample-in-stock-a-line";

function selectedWidth(srcSet: string, currentSrc: string): number | undefined {
  const candidate = srcSet
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .find(
      ([url]) =>
        url !== undefined &&
        new URL(url, "http://127.0.0.1").pathname === new URL(currentSrc).pathname,
    );
  return candidate?.[1] ? Number(candidate[1].replace(/w$/, "")) : undefined;
}

function expectedWidth(cssWidth: number, dpr: number): number {
  return widths.find((width) => width >= cssWidth * dpr) ?? 2048;
}

test.describe("gown gallery and zoom image contract", () => {
  test("uses AVIF hero candidate at rendered width and keeps zoom deferred", async ({ page }) => {
    const mediaRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/media/")) mediaRequests.push(request.url());
    });

    await page.goto(`/gowns/${fixtureSlug}`);
    const hero = page.locator(".gallery img").first();
    await expect(hero).toBeVisible();
    const imageData = await hero.evaluate((node) => {
      const image = node as HTMLImageElement;
      return { currentSrc: image.currentSrc, srcSet: image.srcset };
    });
    expect(imageData.currentSrc).toContain(".avif");
    const box = await hero.boundingBox();
    expect(box).not.toBeNull();
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const picked = selectedWidth(imageData.srcSet, imageData.currentSrc);
    expect(picked).toBe(expectedWidth(box!.width, dpr));
    expect(mediaRequests.some((url) => url.includes("2048") && url.includes("avif"))).toBe(false);

    await hero.click();
    const zoom = page.locator("dialog");
    await expect(zoom).toBeVisible();
    const zoomImage = zoom.locator("img");
    await expect(zoomImage).toBeVisible();
    await expect
      .poll(
        () => mediaRequests.filter((url) => url.includes("2048") && url.includes("avif")).length,
      )
      .toBe(1);
    expect(mediaRequests.some((url) => url.includes("originals"))).toBe(false);

    await page.goBack();
    await expect(zoom).toBeHidden();
    await expect(hero).toBeFocused();
  });

  test("does not overflow viewport", async ({ page }) => {
    await page.goto(`/gowns/${fixtureSlug}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
