import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

// KBS-20-2 / KBS-20-3 against the REAL gown API (PR #26) — no route mocks.
// Staff and session are seeded straight into Postgres (no login UI yet);
// the session cookie carries the raw token, the row only its SHA-256.

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const staffIds: string[] = [];
const gownIds: string[] = [];

test.afterAll(async () => {
  if (gownIds.length) {
    await sql`DELETE FROM price_history WHERE gown_id = ANY(${gownIds})`;
    await sql`DELETE FROM gowns WHERE id = ANY(${gownIds})`; // images cascade
  }
  if (staffIds.length) {
    await sql`DELETE FROM audit_log WHERE actor_user_id = ANY(${staffIds})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${staffIds})`; // sessions cascade
  }
  await sql.end();
});

test("draft → publish gate → publish → unpublish, slug locked, all price states", async ({
  page,
  context,
  baseURL,
}) => {
  const staffId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  staffIds.push(staffId);
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'E2E Staff', ${`e2e-${staffId}@kleibridal.test`}, 'not-used', true)`;
  await sql`
    INSERT INTO sessions (id, staff_user_id, token_hash, expires_at)
    VALUES (${randomUUID()}, ${staffId}, ${createHash("sha256").update(token).digest("hex")},
            now() + interval '1 day')`;
  await context.addCookies([
    { name: "kbs_session", value: token, url: baseURL!, httpOnly: true, sameSite: "Lax" },
  ]);

  // The list's GET is what mints kbs_csrf, as in real navigation.
  const listed = page.waitForResponse((r) => r.url().endsWith("/api/admin/gowns") && r.ok());
  await page.goto("/admin/gowns");
  await listed;
  await page.getByRole("link", { name: "New gown" }).click();

  const name = `E2E Gown ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Price in pesos").fill("45,000");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/gowns\/[0-9a-f-]{36}$/);
  const gownId = page.url().split("/").pop()!;
  gownIds.push(gownId);

  const slug = page.getByLabel("Web address");
  const heading = page.locator("#publish-heading");
  const publishStatus = page.locator("#publish-status");

  // Publish gate: no image → the server's field error, in words.
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(publishStatus).toContainText("Add a gown image before publishing.");
  await expect(heading).toHaveText("Draft — not visible to brides");
  await expect(slug).not.toHaveAttribute("readonly");

  await sql`
    INSERT INTO gown_images (id, gown_id, sort_order, is_hero, original_path, width, height)
    VALUES (${randomUUID()}, ${gownId}, 0, true, 'e2e/placeholder.jpg', 1200, 1600)`;

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(heading).toHaveText("Published");
  await expect(slug).toHaveAttribute("readonly");
  const lockedSlug = await slug.inputValue();

  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(heading).toHaveText("Draft — not visible to brides");
  await expect(slug).toHaveAttribute("readonly");
  await page.reload();
  await expect(slug).toHaveValue(lockedSlug);
  await expect(slug).toHaveAttribute("readonly"); // slug_locked survives unpublish

  // Each price state saves and comes back from the server after a reload.
  for (const label of ["Price on request", "Unlisted"]) {
    await page.getByRole("radio", { name: label }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("radio", { name: label })).toBeChecked();
    await expect(page.getByLabel("Price in pesos")).toHaveCount(0);
  }
  await page.getByRole("radio", { name: "Exact price" }).check();
  await page.getByLabel("Price in pesos").fill("52,500.50");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Exact price" })).toBeChecked();
  await expect(page.getByLabel("Price in pesos")).toHaveValue("PHP 52,500.50");
  await expect(slug).toHaveValue(lockedSlug);
});
