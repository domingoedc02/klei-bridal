import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test as base, type Page, type Route } from "@playwright/test";
import postgres from "postgres";

// Mocked admin-page tests still render through requireStaffPage(), so every
// test gets its own real DB-backed staff + session, with the raw token in the
// kbs_session cookie before any navigation. An auto fixture (not a top-level
// hook) so each importing spec file gets it, and cleanup is per test.
export const test = base.extend<{ adminSession: void }>({
  adminSession: [
    async ({ context, baseURL }, use) => {
      if (!baseURL) throw new Error("Playwright baseURL is required for the admin auth fixture");
      const sql = postgres(
        process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
        { max: 1 },
      );
      const staffId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      try {
        await sql`
          INSERT INTO staff_users (id, name, email, password_hash, is_active)
          VALUES (${staffId}, 'E2E Staff', ${`e2e-${staffId}@kleibridal.test`}, 'not-used', true)`;
        await sql`
          INSERT INTO sessions (id, staff_user_id, token_hash, expires_at)
          VALUES (${randomUUID()}, ${staffId}, ${createHash("sha256").update(token).digest("hex")},
                  now() + interval '1 day')`;
        await context.addCookies([
          { name: "kbs_session", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" },
        ]);
        await use();
      } finally {
        await sql`DELETE FROM staff_users WHERE id = ${staffId}`.catch(() => undefined);
        await sql.end();
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { Page, Route };
