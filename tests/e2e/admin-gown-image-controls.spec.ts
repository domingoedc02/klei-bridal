import { expect, test } from "./admin-auth";

const gownId = "0192a000-0000-7000-8000-000000000021";
const base = `**/api/admin/gowns/${gownId}`;
const makeRows = () =>
  [0, 1, 2].map((i) => ({
    id: `0192a000-0000-7000-8000-00000000010${i}`,
    sort_order: i,
    is_hero: i === 0,
    alt_text: i === 0 ? "Front view" : null,
    width: 10,
    height: 10,
    status: "ready" as const,
  }));

async function setup(page: import("@playwright/test").Page, rows: ReturnType<typeof makeRows>) {
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
  await page.route(`${base}/images`, (route) => route.fulfill({ json: { images: rows } }));
}

async function noOverflow(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

for (const width of [390, 1280]) {
  test(`reorder, hero, alt and delete work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const rows = makeRows();
    await setup(page, rows);
    const requests: string[] = [];
    await page.route(`${base}/images/reorder`, async (route) => {
      requests.push("reorder");
      const body = route.request().postDataJSON() as { order: string[] };
      const byId = new Map(rows.map((row) => [row.id, row]));
      body.order.forEach((id, i) => {
        const row = byId.get(id)!;
        row.sort_order = i;
      });
      return route.fulfill({ json: { images: rows } });
    });
    await page.route(`${base}/images/${rows[1]!.id}/hero`, async (route) => {
      requests.push("hero");
      rows.forEach((row) => (row.is_hero = row.id === rows[1]!.id));
      return route.fulfill({ json: { images: rows } });
    });
    await page.route(`${base}/images/${rows[1]!.id}`, async (route) => {
      if (route.request().method() === "PATCH") {
        requests.push("alt");
        rows[1]!.alt_text = (route.request().postDataJSON() as { alt: string }).alt;
        return route.fulfill({ json: rows[1] });
      }
      requests.push("delete");
      rows.splice(1, 1);
      return route.fulfill({ status: 204 });
    });

    await page.goto(`/admin/gowns/${gownId}`);
    const photos = page.getByRole("list", { name: "Photos" });
    await expect(photos.getByRole("listitem")).toHaveCount(3);
    await photos.getByRole("listitem").nth(1).getByRole("button", { name: "Move earlier" }).click();
    await expect.poll(() => requests).toContain("reorder");
    await photos.getByRole("listitem").nth(1).getByRole("button", { name: "Set as hero" }).click();
    await expect.poll(() => requests).toContain("hero");
    await photos.getByRole("listitem").nth(1).getByLabel("Alt text").fill("Lace detail");
    await photos
      .getByRole("listitem")
      .nth(1)
      .getByRole("button", { name: "Save alt text" })
      .click();
    await expect.poll(() => requests).toContain("alt");
    page.once("dialog", (dialog) => void dialog.accept());
    await photos
      .getByRole("listitem")
      .nth(1)
      .getByRole("button", { name: /Delete photo/ })
      .click();
    await expect.poll(() => requests).toContain("delete");
    await expect(photos.getByRole("listitem")).toHaveCount(2);
    await expect(photos.getByRole("listitem").nth(1)).toBeFocused();
    await noOverflow(page);
  });
}

test("409 mutation shows server message next to image", async ({ page }) => {
  const rows = makeRows();
  await setup(page, rows);
  await page.route(`${base}/images/${rows[1]!.id}/hero`, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { message: "Choose another hero photo first." } },
    }),
  );
  await page.goto(`/admin/gowns/${gownId}`);
  await page
    .getByRole("list", { name: "Photos" })
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: "Set as hero" })
    .click();
  await expect(page.getByText("Choose another hero photo first.")).toBeVisible();
});
