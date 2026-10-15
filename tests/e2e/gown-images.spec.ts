import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const widths = [320, 480, 768, 1024, 1440, 2048];
const stockSlug = "sample-in-stock-a-line";
const madeToOrderSlug = "sample-made-to-order-mermaid";
const mediaPath = /\/media\//;

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

function mediaRequests(urls: string[]): string[] {
  return urls.filter((url) => mediaPath.test(url));
}

async function installCspProbe(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __kbsCspViolations: string[] }).__kbsCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __kbsCspViolations: string[] }).__kbsCspViolations.push(
        `${event.violatedDirective}: ${event.blockedURI}`,
      );
    });
  });
}

async function expectNoCspViolations(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __kbsCspViolations: string[] }).__kbsCspViolations,
      ),
    )
    .toEqual([]);
}

test.describe("gown gallery and zoom image contract", () => {
  test("selects exact hero variant and keeps below-fold images lazy", async ({ page }) => {
    await installCspProbe(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(`/gowns/${stockSlug}`);
    const images = page.locator("section[aria-label$='photographs'] img");
    await expect(images).not.toHaveCount(0);
    const hero = images.first();
    await expect(hero).toBeVisible();
    const data = await hero.evaluate((node) => {
      const image = node as HTMLImageElement;
      return { currentSrc: image.currentSrc, srcSet: image.srcset };
    });
    expect(data.currentSrc).toContain(".avif");
    const box = await hero.boundingBox();
    expect(box).not.toBeNull();
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    expect(selectedWidth(data.srcSet, data.currentSrc)).toBe(expectedWidth(box!.width, dpr));

    const second = images.nth(1);
    const secondSources = await second.evaluate((node) => {
      const image = node as HTMLImageElement;
      return image.srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0]);
    });
    expect(
      mediaRequests(requests).some((url) => secondSources.includes(new URL(url).pathname)),
    ).toBe(false);
    await second.scrollIntoViewIfNeeded();
    await expect.poll(() => mediaRequests(requests).length).toBeGreaterThan(1);
    await expectNoCspViolations(page);
  });

  test("covers in-stock and made-to-order detail contracts", async ({ page }) => {
    await installCspProbe(page);
    await page.goto(`/gowns/${stockSlug}`);
    await expect(page.getByLabel("Available now")).toHaveText("Available now");
    await expect(page.getByRole("link", { name: "Inquire about this gown" })).toHaveAttribute(
      "href",
      `/enquire?gown=${stockSlug}`,
    );

    await page.goto(`/gowns/${madeToOrderSlug}`);
    await expect(page.getByLabel("Made to order")).toHaveText("Made to order");
    await expect(page.getByLabel("Available now")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Inquire about this gown" })).toHaveAttribute(
      "href",
      `/enquire?gown=${madeToOrderSlug}`,
    );
    await expectNoCspViolations(page);
  });

  test("loads one exact 2048 AVIF zoom asset, supports close and restores URL", async ({
    page,
  }) => {
    await installCspProbe(page);
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(`/gowns/${stockSlug}`);
    const hero = page.locator("section[aria-label$='photographs'] img").first();
    const beforeZoom = mediaRequests(requests).length;
    await expect(hero).toBeVisible();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(hero).toHaveAttribute("width");
    expect(mediaRequests(requests).length).toBe(beforeZoom);

    const trigger = hero.locator("xpath=ancestor::a[1]");
    const gownUrl = page.url();
    await trigger.click();
    const dialog = page.locator("dialog");
    await expect(dialog).toBeVisible();
    const zoom = dialog.locator("img");
    await expect(zoom).toBeVisible();
    const zoomData = await zoom.evaluate((node) => {
      const image = node as HTMLImageElement;
      return { currentSrc: image.currentSrc, srcSet: image.srcset };
    });
    expect(zoomData.currentSrc).toContain(".avif");
    expect(selectedWidth(zoomData.srcSet, zoomData.currentSrc)).toBe(2048);
    const zoomUrls = mediaRequests(requests).filter((url) => /\.(avif|webp|jpg)(?:\?|$)/.test(url));
    const zoomPath = new URL(zoomData.currentSrc).pathname;
    expect(zoomUrls.filter((url) => new URL(url).pathname === zoomPath)).toHaveLength(1);
    expect(mediaRequests(requests).some((url) => /originals|\/media\/originals/.test(url))).toBe(
      false,
    );
    expect(selectedWidth(zoomData.srcSet, zoomData.currentSrc)).toBe(2048);

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(gownUrl);
    await expect(hero).toBeFocused();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(gownUrl);
    await expect(hero).toBeFocused();
    await expectNoCspViolations(page);
  });

  test("keeps viewport within width and denies originals route", async ({ page, request }) => {
    await page.goto(`/gowns/${stockSlug}`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const response = await request.get("/media/originals/not-served.jpg");
    expect(response.status()).toBe(404);
  });

  test("keeps approved prototype fixtures sanitized", async ({}, testInfo) => {
    for (const slug of ["gown-detail", "gown-zoom"]) {
      const fixture = await readFile(`tests/e2e/fixtures/kbs-36/${slug}.html`, "utf8");
      expect(fixture).not.toMatch(
        /<script\b|\son[a-z]+\s*=|fonts\.googleapis\.com|<link[^>]+https:\/\//i,
      );
      expect(fixture).toContain("Inquire");
      await testInfo.attach(`${slug}-fixture`, {
        body: Buffer.from(fixture),
        contentType: "text/html",
      });
    }
  });
});
