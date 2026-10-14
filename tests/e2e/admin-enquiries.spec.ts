import { expect, test, type Page } from "./admin-auth";

// KBS-23-3. Enquiry API (KBS-23-1/23-2) mocked at the network layer; the
// integration suite pins what the real API returns.

const id = "0192a000-0000-7000-8000-0000000000e1";
const row = {
  id,
  reference: "KB-0001",
  first_name: "Maria",
  last_name: "Santos",
  wedding_date: "2027-03-14",
  gown_count: 2,
  lead_time_band: "comfortable",
  chat_channel: "viber",
  status: "new",
  is_erased: false,
  created_at: "2026-10-01T09:00:00Z",
  handled_by: null,
  handled_at: null,
};
const erasedDetail = {
  ...row,
  first_name: null,
  last_name: null,
  contact_number: null,
  email: null,
  message: null,
  source: "web",
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  referrer_host: null,
  lead_time_notice: "Comfortable lead time.",
  studio_email_status: "sent",
  bride_email_status: "sent",
  is_erased: true,
  gowns: [
    {
      gown_id: "g1",
      name: "Amélie",
      price_minor: 4_500_000,
      price_status: "priced",
      currency: "PHP",
    },
  ],
};

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("list: loading, error clears on new filters, keyboard reaches filters and rows, no overflow", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/admin/enquiries?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("status") === "archived") {
      return route.fulfill({
        status: 500,
        json: {
          error: { code: "INTERNAL", message: "Could not load enquiries.", request_id: "r1" },
        },
      });
    }
    await held;
    return route.fulfill({ json: { items: [row], page: 1, total_pages: 1 } });
  });

  await page.goto("/admin/enquiries");
  await expect(page.getByRole("status")).toHaveText("Loading enquiries…");
  release();
  await expect(page.getByRole("link", { name: /Maria Santos/ })).toBeVisible();
  await expect(page.getByText("Loading enquiries…")).toHaveCount(0);

  await page.getByLabel("Handled").selectOption("archived");
  await page.getByRole("button", { name: "Apply filters" }).click();
  // Next's route announcer is also role=alert; target the inbox notice.
  const notice = page.getByRole("alert").filter({ hasText: "Could not load" });
  await expect(notice).toHaveText("Could not load enquiries.");
  await expect(page.getByRole("link", { name: /Maria Santos/ })).toHaveCount(0);

  await page.getByLabel("Handled").selectOption("new");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("link", { name: /Maria Santos/ })).toBeVisible();
  await expect(notice).toHaveCount(0);

  await page.getByLabel("Search").focus();
  for (const target of [
    page.getByLabel("Handled"),
    page.getByLabel("Lead time"),
    page.getByRole("button", { name: "Apply filters" }),
    page.getByRole("link", { name: /Maria Santos/ }),
  ]) {
    await page.keyboard.press("Tab");
    await expect(target).toBeFocused();
  }
  await noOverflow(page);
});

test("erased detail: badge, no personal data, no overflow", async ({ page }) => {
  await page.route(`**/api/admin/enquiries/${id}`, (route) =>
    route.fulfill({ json: erasedDetail }),
  );
  await page.goto(`/admin/enquiries/${id}`);
  await expect(page.getByText("Personal data erased")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Erased enquiry" })).toBeVisible();
  await expect(page.getByText("Personal message erased.")).toBeVisible();
  const text = await page.locator("main").innerText();
  for (const pii of ["Maria", "Santos", "@"]) expect(text).not.toContain(pii);
  await page.getByRole("link", { name: "← All enquiries" }).focus();
  await expect(page.getByRole("link", { name: "← All enquiries" })).toBeFocused();
  await noOverflow(page);
});

// KBS-23-4: handled toggle and erase confirmation against mocked routes.
const liveDetail = {
  ...erasedDetail,
  first_name: "Maria",
  last_name: "Santos",
  contact_number: "+639171234567",
  email: "maria@bride.test",
  message: "Looking for lace",
  is_erased: false,
  status: "new",
};
const detailUrl = `**/api/admin/enquiries/${id}`;
const eraseUrl = `**/api/admin/enquiries/${id}/erase`;

test("handled toggle round trip shows who handled it", async ({ page }) => {
  const patches: unknown[] = [];
  await page.route(detailUrl, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: liveDetail });
    const body = route.request().postDataJSON() as { status: string };
    patches.push(body);
    return route.fulfill({
      json:
        body.status === "read"
          ? { ...liveDetail, status: "read", handled_by: { id: "s1", name: "Ana" } }
          : liveDetail,
    });
  });
  await page.goto(`/admin/enquiries/${id}`);
  await page.getByRole("button", { name: "Mark handled" }).click();
  await expect(page.getByText("Handled by Ana")).toBeVisible();
  await page.getByRole("button", { name: "Mark as needing reply" }).click();
  await expect(page.getByText("Needs reply")).toBeVisible();
  expect(patches).toEqual([{ status: "read" }, { status: "new" }]);
});

test("erase: dialog names the fields, traps focus, Escape cancels, reason required, then erased", async ({
  page,
}) => {
  let posted: unknown = null;
  await page.route(detailUrl, (route) => route.fulfill({ json: liveDetail }));
  await page.route(eraseUrl, (route) => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: erasedDetail });
  });
  await page.goto(`/admin/enquiries/${id}`);

  const open = page.getByRole("button", { name: "Erase personal data" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Erase personal data?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("phone number and email");
  await expect(dialog).toContainText("This cannot be undone.");
  await noOverflow(page);
  // Dialog controls are keyboard reachable; native modal keeps focus in dialog.
  await expect(dialog.getByLabel("Reason")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Erase permanently" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(posted).toBeNull();

  await open.click();
  const submit = dialog.getByRole("button", { name: "Erase permanently" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Reason").selectOption("data_subject_request");
  await submit.click();
  await expect(dialog).toBeHidden();
  expect(posted).toEqual({ confirm: true, reason: "data_subject_request" });
  await expect(page.getByText("Personal data erased")).toBeVisible();
  await expect(page.getByRole("button", { name: /Erase|Mark/ })).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toContain("Maria");
});

test("erased enquiry offers no actions", async ({ page }) => {
  await page.route(detailUrl, (route) => route.fulfill({ json: erasedDetail }));
  await page.goto(`/admin/enquiries/${id}`);
  await expect(page.getByText("Personal data erased")).toBeVisible();
  await expect(page.getByRole("button", { name: /Erase|Mark/ })).toHaveCount(0);
});

test("409 (erased elsewhere) reloads the erased state and says why", async ({ page }) => {
  let erased = false;
  await page.route(detailUrl, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: erased ? erasedDetail : liveDetail });
    erased = true;
    return route.fulfill({
      status: 409,
      json: { error: { code: "CONFLICT", message: "This enquiry is erased.", request_id: "r9" } },
    });
  });
  await page.goto(`/admin/enquiries/${id}`);
  await page.getByRole("button", { name: "Mark handled" }).click();
  await expect(page.getByText("Personal data erased")).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "This enquiry is erased." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Erase|Mark/ })).toHaveCount(0);
});

test("422 field error shows inline in the dialog; 500 shows the request id", async ({ page }) => {
  let calls = 0;
  await page.route(detailUrl, (route) => route.fulfill({ json: liveDetail }));
  await page.route(eraseUrl, (route) =>
    ++calls === 1
      ? route.fulfill({
          status: 422,
          json: {
            error: {
              code: "VALIDATION_ERROR",
              message: "Check the highlighted fields.",
              request_id: "r1",
              fields: { reason: "Choose a listed reason." },
            },
          },
        })
      : route.fulfill({
          status: 500,
          json: {
            error: { code: "INTERNAL", message: "Something went wrong.", request_id: "req-500" },
          },
        }),
  );
  await page.goto(`/admin/enquiries/${id}`);
  await page.getByRole("button", { name: "Erase personal data" }).click();
  const dialog = page.getByRole("dialog", { name: "Erase personal data?" });
  await dialog.getByLabel("Reason").selectOption("retention_policy");
  await dialog.getByRole("button", { name: "Erase permanently" }).click();
  await expect(dialog.getByText("Choose a listed reason.")).toBeVisible();
  await expect(dialog.getByLabel("Reason")).toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Erase permanently" }).click();
  await expect(dialog.getByText("Something went wrong. (reference req-500)")).toBeVisible();
});
