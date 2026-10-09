import { expect, test, type Page } from "@playwright/test";

// KBS-20-3. The gown admin API (KBS-20-1/20-2) is mocked at the network
// layer here to pin UI-only edge cases (422 keeps typed values, etc.);
// admin-gowns-real-api.spec.ts runs the same form against the real API.

const draft = {
  id: "0192a000-0000-7000-8000-000000000001",
  slug: "amelie",
  name: "Amélie",
  description: null,
  silhouette_id: null,
  material_ids: [],
  collection_ids: [],
  price_minor: 4_500_000,
  currency: "PHP",
  price_status: "priced",
  slug_locked: false,
  is_in_stock: false,
  status: "draft",
};

async function mockVocab(page: Page) {
  await page.route("**/api/admin/{silhouettes,materials,collections}", (route) =>
    route.fulfill({
      json: { items: [{ id: "mat-1", name: "Lace", slug: "lace", gown_count: 0 }] },
    }),
  );
}

test("new gown: 422 keeps every typed value and shows the field error", async ({ page }) => {
  await mockVocab(page);
  await page.route("**/api/admin/gowns", (route) =>
    route.fulfill({
      status: 422,
      json: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Check the highlighted fields.",
          request_id: "r1",
          fields: { name: "Name is already used" },
        },
      },
    }),
  );
  await page.goto("/admin/gowns/new");
  await expect(page.getByLabel("Made to order only")).toBeChecked();
  await page.getByLabel("Name").fill("Amélie Gown");
  await expect(page.getByLabel("Web address")).toHaveValue("amelie-gown");
  await page.getByLabel("Details").fill("Hand-beaded lace.");
  await page.getByLabel("Price in pesos").fill("₱45,000.00");
  await page.getByLabel("In stock").check();
  await page.getByRole("group", { name: "Materials" }).getByLabel("Lace").check();
  await page.getByRole("button", { name: "Create draft" }).click();

  await expect(page.getByText("Name is already used")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Amélie Gown");
  await expect(page.getByLabel("Details")).toHaveValue("Hand-beaded lace.");
  await expect(page.getByLabel("Price in pesos")).toHaveValue("PHP 45,000.00");
  await expect(page.getByLabel("In stock")).toBeChecked();
  await expect(page.getByRole("group", { name: "Materials" }).getByLabel("Lace")).toBeChecked();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("publish refusal shows its reason; publishing locks the slug", async ({ page }) => {
  await mockVocab(page);
  let publishCalls = 0;
  await page.route(`**/api/admin/gowns/${draft.id}`, (route) => route.fulfill({ json: draft }));
  await page.route(`**/api/admin/gowns/${draft.id}/publish`, (route) => {
    publishCalls += 1;
    return publishCalls === 1
      ? route.fulfill({
          status: 422,
          json: {
            error: {
              code: "VALIDATION_ERROR",
              message: "Add at least one photo before publishing.",
              request_id: "r2",
            },
          },
        })
      : route.fulfill({ json: { ...draft, status: "published", slug_locked: true } });
  });
  await page.goto(`/admin/gowns/${draft.id}`);
  await expect(page.getByLabel("Web address")).toHaveValue("amelie");
  await expect(page.getByLabel("Web address")).not.toHaveAttribute("readonly");

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Add at least one photo before publishing.")).toBeVisible();

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await expect(page.getByLabel("Web address")).toHaveAttribute("readonly");

  await page.route(`**/api/admin/gowns/${draft.id}`, (route) =>
    route.fulfill({ json: { ...draft, status: "draft", slug_locked: true } }),
  );
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  await expect(page.getByLabel("Web address")).toHaveAttribute("readonly");
});

test("unlisted gown stays unlisted when saved", async ({ page }) => {
  await mockVocab(page);
  const unlisted = { ...draft, price_status: "unlisted", price_minor: null };
  let savedBody: Record<string, unknown> | undefined;
  await page.route(`**/api/admin/gowns/${draft.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: unlisted });
    }
    return route.fulfill({ json: unlisted });
  });
  await page.goto(`/admin/gowns/${draft.id}`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedBody?.price_status).toBe("unlisted");
  expect(savedBody?.price_minor).toBeNull();
});

test("gown list shows status, PHP price and availability", async ({ page }) => {
  await page.route("**/api/admin/gowns", (route) =>
    route.fulfill({
      json: {
        items: [
          draft,
          { ...draft, id: "x2", name: "Belle", price_status: "on_request", price_minor: null },
        ],
      },
    }),
  );
  await page.goto("/admin/gowns");
  await expect(page.getByText("PHP 45,000.00")).toBeVisible();
  await expect(page.getByText("Price on request")).toBeVisible();
  await expect(page.getByRole("link", { name: "New gown" })).toBeVisible();
});
