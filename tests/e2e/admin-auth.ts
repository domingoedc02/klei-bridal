import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test as base, type Page } from "@playwright/test";
import postgres from "postgres";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const staffIds: string[] = [];

// Mocked admin-page tests still render through requireStaffPage(), so give each
// test its own real DB-backed session before navigation.
export { expect };
export type { Page };
export const test = base;

test.beforeEach(async ({ context, baseURL }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required for admin auth fixture");
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
    { name: "kbs_session", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" },
  ]);
});

test.afterAll(async () => {
  if (staffIds.length) await sql`DELETE FROM staff_users WHERE id = ANY(${staffIds})`;
  await sql.end();
});
