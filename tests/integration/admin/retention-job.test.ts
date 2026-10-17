import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";
import { settings } from "@/server/db/schema";
import { anonymiseEnquiry } from "@/server/services/enquiry-erasure";
import { runRetention } from "@/server/worker/retentionJob";

/** KBS-30-3: the retention job ships off, and works when switched on. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const ids: string[] = [];
let gownId: string;
let staffId: string;
let saved: unknown[];

async function enquiry(ageMonths: number) {
  const id = randomUUID();
  await sql`
    INSERT INTO enquiries (id, reference, token_hash, first_name, last_name, contact_number, email,
      wedding_date, message, source, lead_time_band_shown, lead_time_notice_shown, created_at)
    VALUES (${id}, ${`KB-${id.slice(0, 4).toUpperCase()}-RT`}, ${randomUUID()}, 'Ret', 'Test',
      '+639171234567', ${`${id}@bride.test`}, '2027-02-14', 'hello', 'social', 'comfortable', 'n',
      now() - make_interval(months => ${ageMonths}))
  `;
  await sql`INSERT INTO enquiry_gowns VALUES (${id}, ${gownId}, 'Snap', 100, 'priced', 'PHP')`;
  ids.push(id);
  return id;
}
const row = async (id: string) => (await sql`SELECT * FROM enquiries WHERE id = ${id}`)[0]!;
const audits = (id: string) =>
  sql`SELECT actor_user_id, detail FROM audit_log WHERE entity_id = ${id} AND action = 'enquiry.erase'`;
// Written through drizzle, as the app does (it round-trips jsonb its own way).
const KEYS = ["retention_enabled", "retention_months"] as const;
const setSettings = async (...values: unknown[]) => {
  for (const [i, key] of KEYS.entries())
    await db
      .insert(settings)
      .values({ key, value: values[i] })
      .onConflictDoUpdate({ target: settings.key, set: { value: values[i] } });
};

beforeAll(async () => {
  const rows = await db.select().from(settings);
  saved = KEYS.map((k) => rows.find((r) => r.key === k)?.value ?? null);
  staffId = randomUUID();
  await sql`INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Ret Test', ${`ret-${staffId}@kleibridal.test`}, 'x', true)`;
  gownId = randomUUID();
  await sql`INSERT INTO gowns (id, slug, name, status, price_status, price_minor, currency, created_by, updated_by)
    VALUES (${gownId}, ${`ret-${gownId}`}, 'G', 'published', 'priced', 1, 'PHP', ${staffId}, ${staffId})`;
});

afterAll(async () => {
  await sql`DELETE FROM audit_log WHERE entity_id = ANY(${ids}) OR actor_user_id = ${staffId}`;
  await sql`DELETE FROM enquiries WHERE id = ANY(${ids})`;
  await sql`DELETE FROM gowns WHERE id = ${gownId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await setSettings(...saved);
  await sql.end();
  await db.$client.end();
});

describe("runRetention", () => {
  it("is a no-op while disabled (the shipped state)", async () => {
    const old = await enquiry(30);
    await setSettings(false, 24);
    expect(await runRetention()).toEqual({ ran: false, reason: "disabled" });
    expect((await row(old)).email).not.toBeNull();
    expect(await audits(old)).toHaveLength(0);
  });

  it("treats a non-boolean flag and bad months as off", async () => {
    const old = await enquiry(30);
    await setSettings("yes", 24);
    expect(await runRetention()).toEqual({ ran: false, reason: "disabled" });
    await setSettings(true, 0);
    expect(await runRetention()).toEqual({ ran: false, reason: "invalid_months" });
    expect((await row(old)).email).not.toBeNull();
  });

  it("anonymises only enquiries past the cutoff, keeps the rest, audits with no actor", async () => {
    const old = await enquiry(30);
    const fresh = await enquiry(2);
    const already = await enquiry(40);
    await setSettings(true, 24);
    await db.transaction((tx) =>
      anonymiseEnquiry(tx as never, already, {
        actorUserId: staffId,
        trigger: "manual",
        reason: "data_subject_request",
      }),
    );
    expect(await runRetention()).toMatchObject({ ran: true });

    const o = await row(old);
    expect([o.first_name, o.last_name, o.contact_number, o.email, o.message]).toEqual([
      null, null, null, null, null,
    ]);
    expect(new Date(o.wedding_date).toISOString().slice(0, 10)).toBe("2027-02-14");
    expect(o.source).toBe("social");
    expect(await sql`SELECT 1 FROM enquiry_gowns WHERE enquiry_id = ${old}`).toHaveLength(1);
    const a = await audits(old);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      actor_user_id: null,
      detail: { trigger: "retention", reason: "retention_policy" },
    });

    expect((await row(fresh)).email).not.toBeNull();
    // Already-erased row: not touched again, its manual audit row intact.
    const prior = await audits(already);
    expect(prior).toHaveLength(1);
    expect(prior[0]).toMatchObject({ actor_user_id: staffId });

    // Count never drops: erased rows still exist.
    expect(await sql`SELECT id FROM enquiries WHERE id = ANY(${ids})`).toHaveLength(ids.length);
    // Second run is idempotent.
    await runRetention();
    expect(await audits(old)).toHaveLength(1);
  });
});
