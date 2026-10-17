import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "../../app/api/send-my-list/route";
import { db } from "@/server/db/client";
import { sendMyListEmail } from "@/server/services/send-my-list";
import { csrfHeaders } from "./csrf-headers";

const sql = postgres(process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev", { max: 1 });
let staffId: string;
let live: string;
let draft: string;
const body = (extra: Record<string, unknown> = {}) => ({ email: `list-${randomUUID()}@kleibridal.test`, gown_ids: [live], ...extra });
const post = (value: unknown) => POST(new NextRequest("http://localhost:3000/api/send-my-list", { method: "POST", headers: { ...csrfHeaders(), "content-type": "application/json", "x-real-ip": `198.51.100.${Math.floor(Math.random() * 200) + 1}` }, body: JSON.stringify(value) }));

beforeAll(async () => {
  staffId = randomUUID();
  await sql`INSERT INTO staff_users (id, name, email, password_hash, is_active) VALUES (${staffId}, 'List Test', ${`list-${staffId}@kleibridal.test`}, 'x', true)`;
  live = randomUUID(); draft = randomUUID();
  for (const [id, status] of [[live, "published"], [draft, "draft"]] as const)
    await sql`INSERT INTO gowns (id, slug, name, status, price_status, price_minor, currency, created_by, updated_by) VALUES (${id}, ${`list-${id}`}, 'List Gown', ${status}, 'priced', 100, 'PHP', ${staffId}, ${staffId})`;
});
afterAll(async () => { await sql`DELETE FROM gowns WHERE id IN (${live}, ${draft})`; await sql`DELETE FROM staff_users WHERE id=${staffId}`; await sql.end(); await db.$client.end(); });

describe("POST /api/send-my-list", () => {
  it("validates, re-resolves published ids, and returns 202", async () => {
    const res = await post(body());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });
  });
  it("drops stale and unpublished ids but refuses empty result", async () => {
    expect((await post(body({ gown_ids: [live, draft, randomUUID()] }))).status).toBe(202);
    expect((await post(body({ gown_ids: [draft] }))).status).toBe(422);
  });
  it("escapes gown data in both message formats", () => {
    const message = sendMyListEmail("x@example.com", [{ id: live, slug: "a\"b", name: "<Gown>", priceMinor: null, currency: "PHP", priceStatus: "on_request" }]);
    expect(message.html).not.toContain("<Gown>");
    expect(message.html).toContain("&lt;Gown&gt;");
  });
});
