import { readFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const widths = [320, 480, 768, 1024, 1440, 2048];
const stockSlug = "sample-in-stock-a-line";
const madeToOrderSlug = "sample-made-to-order-mermaid";
const mediaPath = /\/media\//;

function selectedWidth(srcSet: string, currentSrc: string): number | undefined {
  const currentPath = new URL(currentSrc, "http://127.0.0.1").pathname;
  const candidate = srcSet
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .find(
      ([url]) => url !== undefined && new URL(url, "http://127.0.0.1").pathname === currentPath,
    );
  return candidate?.[1] ? Number(candidate[1].replace(/w$/, "")) : undefined;
}

function expectedWidth(viewportWidth: number, dpr: number): number {
  const slotWidth =
    viewportWidth >= 1440 ? 860 : viewportWidth >= 1024 ? viewportWidth * 0.6 : viewportWidth;
  return widths.find((width) => width >= slotWidth * dpr) ?? 2048;
}

async function waitForImage(image: import("@playwright/test").Locator) {
  await expect
    .poll(
      () =>
        image.evaluate((node) => {
          const element = node as HTMLImageElement;
          return {
            complete: element.complete,
            naturalWidth: element.naturalWidth,
            currentSrc: element.currentSrc,
          };
        }),
      { timeout: 10_000 },
    )
    .toMatchObject({ complete: true });
  await expect
    .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
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

type PrototypeScreen = "gown-detail" | "gown-zoom";

async function layoutDiagnostics(page: Page) {
  return page.evaluate(() => {
    const properties = [
      "display",
      "position",
      "boxSizing",
      "margin",
      "padding",
      "border",
      "backgroundColor",
      "color",
      "font",
      "lineHeight",
      "opacity",
      "overflow",
    ] as const;
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
      },
      elements: [...document.querySelectorAll("body *:not(img)")].map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          tag: node.tagName.toLowerCase(),
          text: node.textContent?.trim().replace(/\\s+/g, " ").slice(0, 80) ?? "",
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          style: Object.fromEntries(properties.map((property) => [property, style[property]])),
        };
      }),
    };
  });
}

async function attachLayoutDiagnostics(
  testInfo: TestInfo,
  name: string,
  diagnostics: Awaited<ReturnType<typeof layoutDiagnostics>>,
) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
    contentType: "application/json",
  });
}

async function comparePrototypeFixture(page: Page, fixture: PrototypeScreen, testInfo: TestInfo) {
  const html = await readFile(`tests/e2e/fixtures/kbs-36/${fixture}.html`, "utf8");
  expect(html).not.toMatch(/<script\b|\son[a-z]+\s*=|fonts\.googleapis\.com|<link[^>]+https:\/\//i);
  await testInfo.attach(`${fixture}-fixture`, {
    body: Buffer.from(html),
    contentType: "text/html",
  });

  const width = page.viewportSize()?.width;
  expect([390, 1280]).toContain(width);
  if (testInfo.project.name.endsWith("dpr2") || testInfo.project.name.endsWith("dpr3")) return;

  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const maskStyle =
    "img { display: block !important; width: 100% !important; height: calc(100vw - 16px) !important; aspect-ratio: auto !important; object-fit: cover !important; opacity: 0 !important; }";
  const prototypeMask = [page.locator("img")];
  const prototypeCapture = await page.screenshot({
    mask: prototypeMask,
    maskColor: "#ffffff",
    style: maskStyle,
  });
  await attachLayoutDiagnostics(
    testInfo,
    `${fixture}-fixture-layout`,
    await layoutDiagnostics(page),
  );
  await testInfo.attach(`${fixture}-fixture-capture`, {
    body: prototypeCapture,
    contentType: "image/png",
  });
  await expect(prototypeCapture).toMatchSnapshot(`${fixture}-fixture-${width}.png`, {
    maxDiffPixelRatio: 0.02,
  });

  if (fixture === "gown-detail") {
    await page.goto(`/gowns/${stockSlug}`);
  } else {
    await page.goto(`/gowns/${stockSlug}`);
    await page.locator("section[aria-label$='photographs'] img").first().click();
    await expect(page.locator("dialog")).toBeVisible();
    await expect(page.locator("dialog")).toHaveCSS("opacity", "1");
  }

  const image = page
    .locator(fixture === "gown-detail" ? "section[aria-label$='photographs'] img" : "dialog img")
    .first();
  await waitForImage(image);
  const mask = [
    fixture === "gown-detail" ? page.locator("section[aria-label$='photographs'] img") : image,
  ];
  const builtCapture = await page.screenshot({
    mask,
    maskColor: "#ffffff",
    style: maskStyle,
  });
  await attachLayoutDiagnostics(testInfo, `${fixture}-built-layout`, await layoutDiagnostics(page));
  await testInfo.attach(`${fixture}-built-capture`, {
    body: builtCapture,
    contentType: "image/png",
  });
  const { default: sharp } = await import("sharp");
  const prototypePixels = await sharp(prototypeCapture).raw().toBuffer({ resolveWithObject: true });
  const builtPixels = await sharp(builtCapture).raw().toBuffer({ resolveWithObject: true });
  expect(builtPixels.info).toEqual(prototypePixels.info);
  let differentPixels = 0;
  for (let index = 0; index < prototypePixels.data.length; index += 1) {
    if (prototypePixels.data[index] !== builtPixels.data[index]) differentPixels += 1;
  }
  expect(
    differentPixels / prototypePixels.info.width / prototypePixels.info.height,
  ).toBeLessThanOrEqual(0.02);
  await expect(builtCapture).toMatchSnapshot(`${fixture}-${width}.png`, {
    maxDiffPixelRatio: 0.02,
  });
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
    await waitForImage(hero);
    const data = await hero.evaluate((node) => {
      const image = node as HTMLImageElement;
      const source = image.closest("picture")?.querySelector('source[type="image/avif"]');
      return { currentSrc: image.currentSrc, srcSet: source?.getAttribute("srcset") ?? "" };
    });
    expect(data.currentSrc).toContain(".avif");
    const viewportWidth = page.viewportSize()?.width;
    expect(viewportWidth).toBeDefined();
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    const picked = selectedWidth(data.srcSet, data.currentSrc);
    expect(picked).toBe(expectedWidth(viewportWidth!, dpr));
    const heroCandidates = new Map(
      data.srcSet.split(",").map((entry) => {
        const [url, descriptor] = entry.trim().split(/\s+/);
        return [new URL(url!, page.url()).pathname, Number(descriptor!.replace("w", ""))];
      }),
    );
    const heroRequests = mediaRequests(requests)
      .map((url) => heroCandidates.get(new URL(url).pathname))
      .filter((width): width is number => width !== undefined);
    expect(heroRequests).toEqual([picked]);
    expect(heroRequests.every((width) => width <= picked!)).toBe(true);

    const belowFold = await images.evaluateAll((nodes) =>
      nodes.slice(1).map((node) => {
        const image = node as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          loading: image.loading,
          currentSrc: image.currentSrc,
          sources: image.srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0]),
        };
      }),
    );
    expect(belowFold.every((image) => image.loading === "lazy")).toBe(true);
    expect(belowFold.every((image) => image.bottom > image.top)).toBe(true);
    for (const image of belowFold) {
      expect(image.loading).toBe("lazy");
    }
    for (const image of await images.all().then((all) => all.slice(1))) {
      await image.scrollIntoViewIfNeeded();
      await waitForImage(image);
    }
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
    await waitForImage(zoom);
    const zoomData = await zoom.evaluate((node) => {
      const image = node as HTMLImageElement;
      const source = image.closest("picture")?.querySelector('source[type="image/avif"]');
      return { currentSrc: image.currentSrc, srcSet: source?.getAttribute("srcset") ?? "" };
    });
    expect(zoomData.currentSrc).toContain(".avif");
    const metadata = await zoom.evaluate((node) => {
      const image = node as HTMLImageElement;
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(Math.max(metadata.width, metadata.height)).toBe(2048);
    expect(selectedWidth(zoomData.srcSet, zoomData.currentSrc)).toBe(2048);
    const zoomUrls = mediaRequests(requests).filter((url) => /\.(avif|webp|jpg)(?:\?|$)/.test(url));
    const zoomPath = new URL(zoomData.currentSrc).pathname;
    expect(zoomUrls.filter((url) => new URL(url).pathname === zoomPath)).toHaveLength(1);
    const zoomRequests = mediaRequests(requests).filter((url) => {
      const pathname = new URL(url).pathname;
      return pathname === zoomPath;
    });
    expect(zoomRequests).toHaveLength(1);
    expect(mediaRequests(requests).some((url) => /originals|\/media\/originals/.test(url))).toBe(
      false,
    );
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(gownUrl);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(gownUrl);
    await expect(trigger).toBeFocused();
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

  test("matches committed approved prototype fixture baselines", async ({ page }, testInfo) => {
    await comparePrototypeFixture(page, "gown-detail", testInfo);
    await comparePrototypeFixture(page, "gown-zoom", testInfo);
  });
});
