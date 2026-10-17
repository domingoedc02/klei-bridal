import { expect, test, type Page } from "@playwright/test";

// KBS-12: tap-to-zoom ACs (AC-RSP-05 at 390 + 1280, reachability of 6 and 10
// photos, scroll position kept, no-JS fallback, AC-PERF zoom budget).
// The lace fixtures come from scripts/seed-e2e-gowns.ts (pnpm db:seed:e2e).

const six = "/gowns/e2e-zoom-six";
const ten = "/gowns/e2e-zoom-ten";
const photos = "section[aria-label$='photographs']";

async function openZoom(page: Page, index = 0) {
  const trigger = page.locator(`${photos} a`).nth(index);
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

for (const [path, total] of [
  [six, 6],
  [ten, 10],
] as const) {
  test(`every one of ${total} photographs is reachable from inside the zoom`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator(`${photos} li`)).toHaveCount(total);
    const { dialog } = await openZoom(page);
    const seen = new Set<string>();
    for (let step = 0; step < total; step++) {
      const label = await dialog.getAttribute("aria-label");
      expect(label).toMatch(new RegExp(`photograph ${step + 1} of ${total}$`));
      seen.add(label!);
      await expect(dialog.getByText(`${step + 1} / ${total}`)).toBeVisible();
      await page.keyboard.press("ArrowRight");
    }
    expect(seen.size).toBe(total);
    // wraps back to the first
    await expect(dialog.getByText(`1 / ${total}`)).toBeVisible();
  });
}

test("close control and back gesture return to the same scroll position", async ({ page }) => {
  await page.goto(six);
  const { trigger, dialog } = await openZoom(page, 3);
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("zoom image is full width, pinch/pan stays enabled, page does not overflow", async ({
  page,
}) => {
  await page.goto(six);
  const { dialog } = await openZoom(page);
  const img = dialog.locator("img");
  await expect(img).toBeVisible();
  const info = await img.evaluate((node) => {
    const el = node as HTMLImageElement;
    return {
      natural: el.naturalWidth,
      shown: el.getBoundingClientRect().width,
      touch: getComputedStyle(el).touchAction,
      dialogOverflow: getComputedStyle(el.closest("dialog")!).overflow,
    };
  });
  expect(info.natural).toBe(2048);
  expect(Math.round(info.shown)).toBe(page.viewportSize()!.width);
  expect(info.touch).toMatch(/pinch-zoom|manipulation/); // the prototype's pan/zoom contract
  expect(info.dialogOverflow).toBe("auto");
  const viewport = await page.evaluate(
    () => document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? "",
  );
  expect(viewport).not.toMatch(/user-scalable=no|maximum-scale=1(\.0)?(,|$)/);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("photo is visible and links to the largest file; nothing broken", async ({ page }) => {
    await page.goto(six);
    const link = page.locator(`${photos} a`).first();
    await expect(link.locator("img")).toBeVisible();
    await expect(link).toHaveAttribute("href", /^\/media\/.+\.avif$/);
    await expect(page.locator("dialog")).toHaveCount(0);
    const res = await page.request.get((await link.getAttribute("href"))!);
    expect(res.status()).toBe(200);
  });
});

// AC-PERF (KBS-12): slow-4G / 4x CPU, 390px, ≤600KB transferred, ≤4.0s median of 5.
test("zoom asset ≤600KB and decoded ≤4.0s on slow 4G / 4x CPU (median of 5)", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "budget is defined at 390px");
  test.setTimeout(180_000);
  const times: number[] = [];
  for (let run = 0; run < 5; run++) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${40 + run}` },
    });
    const page = await context.newPage();
    await page.goto(`${baseURL}${ten}`, { waitUntil: "load" });
    // let the hero settle on the unthrottled link, then throttle for the tap
    await expect(page.locator(`${photos} img`).first()).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
      latency: 150,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const trigger = page.locator(`${photos} a`).first();
    const started = Date.now();
    await trigger.click();
    const img = page.locator("dialog[open] img");
    await expect(img).toBeVisible();
    const result = await img.evaluate(async (node) => {
      const el = node as HTMLImageElement;
      await el.decode();
      const entry = performance
        .getEntriesByType("resource")
        .find((e) => e.name === el.currentSrc) as PerformanceResourceTiming | undefined;
      return {
        natural: el.naturalWidth,
        transfer: entry?.transferSize ?? 0,
        encoded: entry?.encodedBodySize ?? 0,
      };
    });
    times.push((Date.now() - started) / 1000);
    expect(result.natural).toBe(2048);
    expect(result.transfer || result.encoded).toBeGreaterThan(0);
    expect(result.transfer || result.encoded).toBeLessThanOrEqual(600 * 1000);
    await context.close();
  }
  times.sort((a, b) => a - b);
  const median = times[2]!;
  testInfo.annotations.push({ type: "zoom-median-s", description: String(median) });
  expect(median).toBeLessThanOrEqual(4.0);
});
