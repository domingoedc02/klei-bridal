import { expect, test, type Page, type Route } from "@playwright/test";

// KBS-21-5/-6. Images API mocked at network layer (spec/api/admin-images
// shapes); server routes covered by KBS-21-1/-4 tests.

const gownId = "0192a000-0000-7000-8000-000000000021";
const base = `**/api/admin/gowns/${gownId}`;
const jpeg = (name: string) => ({
  name,
  mimeType: "image/jpeg",
  buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(2048).fill(0)]),
});
const image = (i: number, status = "pending") => ({
  id: `0192a000-0000-7000-8000-00000000010${i}`,
  sort_order: i,
  is_hero: i === 0,
  alt_text: null,
  width: 10,
  height: 10,
  status,
});

async function mockGown(page: Page) {
  await page.route("**/api/admin/{silhouettes,materials,collections}", (r) =>
    r.fulfill({ json: { items: [] } }),
  );
  await page.route(base, (r) =>
    r.fulfill({
      json: {
        id: gownId,
        slug: "amelie",
        name: "Amélie",
        description: null,
        silhouette_id: null,
        material_ids: [],
        collection_ids: [],
        price_minor: null,
        currency: "PHP",
        price_status: "on_request",
        slug_locked: false,
        is_in_stock: false,
        status: "draft",
      },
    }),
  );
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("each file gets its own progress; a failed file alone offers retry; status settles to Ready", async ({
  page,
}) => {
  await mockGown(page);
  const stored: ReturnType<typeof image>[] = [];
  let posts = 0;
  let held: Route | null = null;
  let thirdFails = true;
  await page.route(`${base}/images`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { images: stored } });
    posts += 1;
    if (posts === 1) {
      held = route; // hold the first upload so its progress bar is observable
      return;
    }
    if (posts === 3 && thirdFails)
      return route.fulfill({
        status: 422,
        json: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Check the highlighted fields.",
            request_id: "r1",
            fields: { files: "Upload a JPEG, PNG or WebP photo." },
          },
        },
      });
    const next = image(stored.length);
    stored.push(next);
    return route.fulfill({ status: 201, json: { images: [next] } });
  });

  await page.goto(`/admin/gowns/${gownId}`);
  await expect(page.getByText("No photos yet.")).toBeVisible();
  await page.getByLabel("Add photos").setInputFiles([jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")]);

  await expect(page.getByRole("progressbar", { name: "Uploading a.jpg" })).toBeVisible();
  await expect.poll(() => held !== null).toBe(true);
  const first = image(0);
  stored.push(first);
  await held!.fulfill({ status: 201, json: { images: [first] } });

  const photos = page.getByRole("list", { name: "Photos" });
  await expect(photos.getByRole("listitem")).toHaveCount(2);
  await expect(photos.getByText("Processing")).toHaveCount(2);
  // Only the failed file offers retry, with the server's own words.
  await expect(
    page.getByRole("list", { name: "Uploads" }).getByText("Upload a JPEG, PNG or WebP photo."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry c.jpg" })).toBeVisible();
  // No hash, storage path or file name leaks into the stored gallery.
  await expect(photos).not.toContainText(/\.jpg|\/media\//);

  thirdFails = false;
  await page.getByRole("button", { name: "Retry c.jpg" }).click();
  await expect(photos.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("list", { name: "Uploads" })).toHaveCount(0);

  // Encodes drain; polling turns every row Ready and announces it.
  for (const s of stored) s.status = "ready";
  await expect(photos.getByText("Ready")).toHaveCount(3, { timeout: 10_000 });
  await expect(page.locator("[aria-live=polite]")).toHaveText(/Photo \d ready\./);
  await noOverflow(page);
});

test("an encode failure shows Failed with Retry, which re-queues the image", async ({ page }) => {
  await mockGown(page);
  const gallery = [image(0, "ready"), image(1, "failed")];
  let retried = false;
  await page.route(`${base}/images`, (r) => r.fulfill({ json: { images: gallery } }));
  await page.route(`${base}/images/${gallery[1]!.id}/retry`, (r) => {
    retried = true;
    gallery[1]!.status = "pending";
    return r.fulfill({ json: gallery[1] });
  });
  await page.goto(`/admin/gowns/${gownId}`);
  await expect(page.getByText("Failed")).toBeVisible();
  // The gown stays publishable: the publish control is untouched by a failed image.
  await expect(page.getByRole("button", { name: "Publish" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry photo 2" }).click();
  await expect.poll(() => retried).toBe(true);
  await expect(page.getByRole("list", { name: "Photos" }).getByText("Processing")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  await noOverflow(page);
});

test("an 11th photo is refused with the limit stated, before any upload", async ({ page }) => {
  await mockGown(page);
  let posts = 0;
  const gallery = Array.from({ length: 9 }, (_, i) => image(i, "ready"));
  await page.route(`${base}/images`, (r) => {
    if (r.request().method() === "POST") posts += 1;
    return r.fulfill({ json: { images: gallery } });
  });
  await page.goto(`/admin/gowns/${gownId}`);
  await expect(page.getByRole("list", { name: "Photos" }).getByRole("listitem")).toHaveCount(9);
  await page.getByLabel("Add photos").setInputFiles([jpeg("x.jpg"), jpeg("y.jpg")]);
  await expect(page.getByRole("alert").filter({ hasText: "at most 10 photos" })).toHaveText(
    "A gown can have at most 10 photos. You can add 1 more; you chose 2.",
  );
  expect(posts).toBe(0);
});
