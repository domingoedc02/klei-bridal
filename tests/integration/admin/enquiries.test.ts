import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as detail } from "../../../app/api/admin/enquiries/[id]/route";
import { GET as list } from "../../../app/api/admin/enquiries/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { csrfHeaders } from "../csrf-headers";

/** KBS-23-1: enquiry inbox list and audited detail, through the real routes. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
// A tag only this run's rows carry, so the list can be scoped to them via search.
const TAG = `zq${randomUUID().slice(0, 8)}`;
let staffId: string;
let session: string;
let gownId: string;
const enquiryIds: string[] = [];

async function enquiry(o: {
  wedding: string;
  first?: string;
  band?: string;
  channel?: string | null;
  status?: string;
  createdAt?: string;
}) {
  const id = randomUUID();
  const reference = `KB-${randomUUID().slice(0, 4).toUpperCase()}-TEST`;
  await sql`
    INSERT INTO enquiries (id, reference, token_hash, first_name, last_name, contact_number, email,
      wedding_date, message, source, chat_channel_chosen, lead_time_band_shown, lead_time_notice_shown,
      status, created_at)
    VALUES (${id}, ${reference}, ${randomUUID()}, ${o.first ?? "Maria"}, ${TAG}, '+639170000000',
      ${`${id}@bride.test`}, ${o.wedding}, 'Secret message', 'social', ${o.channel ?? null},
      ${o.band ?? "comfortable"}, 'Notice she saw', ${o.status ?? "new"}, ${o.createdAt ?? new Date().toISOString()})
  `;
  enquiryIds.push(id);
  return { id, reference };
}

function get(url: string) {
  return new NextRequest(`http://localhost:3000${url}`, {
    headers: { ...csrfHeaders(`${SESSION_COOKIE}=${session}`), "x-real-ip": "203.0.113.31" },
  });
}
const listOf = async (qs: string) => {
  const res = await list(get(`/api/admin/enquiries?search=${TAG}&${qs}`), {} as never);
  expect(res.status).toBe(200);
  return res.json();
};
const open = (id: string) =>
  detail(get(`/api/admin/enquiries/${id}`), { params: Promise.resolve({ id }) } as never);
const views = (id: string) =>
  sql`SELECT actor_user_id, occurred_at FROM audit_log WHERE action = 'enquiry.view' AND entity_id = ${id}`;

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Inbox Test', ${`inbox-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  session = (await createSession(db, { staffUserId: staffId, ip: null, userAgent: null })).token;
  gownId = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, price_status, price_minor, currency, created_by, updated_by)
    VALUES (${gownId}, ${`inbox-${gownId}`}, 'Current Name', 'published', 'priced', 999900, 'PHP', ${staffId}, ${staffId})
  `;
});

afterAll(async () => {
  await sql`DELETE FROM audit_log WHERE entity_id = ANY(${enquiryIds}) OR actor_user_id = ${staffId}`;
  await sql`DELETE FROM enquiries WHERE id = ANY(${enquiryIds})`;
  await sql`DELETE FROM gowns WHERE id = ${gownId}`;
  await sql`DELETE FROM sessions WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("GET /api/admin/enquiries", () => {
  it("sorts by wedding date, then submission time, and omits message and contact details", async () => {
    const june = await enquiry({ wedding: "2027-06-01" });
    const decLate = await enquiry({ wedding: "2026-12-12", createdAt: "2026-10-02T00:00:00Z" });
    const decEarly = await enquiry({ wedding: "2026-12-12", createdAt: "2026-10-01T00:00:00Z" });
    const march = await enquiry({ wedding: "2027-03-01", channel: "whatsapp" });
    await sql`INSERT INTO enquiry_gowns VALUES (${march.id}, ${gownId}, 'Snap', 100, 'priced', 'PHP')`;

    const body = await listOf("");
    expect(body.items.map((r: { id: string }) => r.id)).toEqual([
      decEarly.id,
      decLate.id,
      march.id,
      june.id,
    ]);
    const row = body.items[2];
    expect(row).toMatchObject({
      gown_count: 1,
      chat_channel: "whatsapp",
      lead_time_band: "comfortable",
      status: "new",
      handled_by: null,
      handled_at: null,
      is_erased: false,
    });
    for (const k of ["message", "email", "contact_number"]) expect(row).not.toHaveProperty(k);
    expect(JSON.stringify(body)).not.toContain("Secret message");
    expect(body).toMatchObject({ page: 1, per_page: 24, total_items: 4, total_pages: 1 });
  });

  it("filters by repeatable status and band, and searches by name, email and exact reference", async () => {
    const read = await enquiry({
      wedding: "2027-01-01",
      status: "read",
      band: "rush",
      first: "Isabel",
    });
    await enquiry({ wedding: "2027-01-02", status: "archived", band: "in_stock_only" });

    const ids = (b: { items: { id: string }[] }) => b.items.map((r) => r.id);
    expect(ids(await listOf("status=read&band=rush"))).toEqual([read.id]);
    expect(ids(await listOf("status=read&status=archived")).length).toBe(2);

    const byName = await list(get(`/api/admin/enquiries?search=isabel%20${TAG}`), {} as never);
    expect(ids(await byName.json())).toEqual([read.id]);
    const byEmail = await list(get(`/api/admin/enquiries?search=${read.id}@bride`), {} as never);
    expect(ids(await byEmail.json())).toEqual([read.id]);
    const byRef = await list(
      get(`/api/admin/enquiries?search=${read.reference.toLowerCase()}`),
      {} as never,
    );
    expect(ids(await byRef.json())).toEqual([read.id]);
  });

  it("answers a never-issued reference exactly like a non-matching search", async () => {
    const strip = async (search: string) => {
      const res = await list(get(`/api/admin/enquiries?search=${search}`), {} as never);
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await strip("KB-ZZZZ-ZZZZ")).toEqual(await strip(`nomatch${TAG}`));
  });

  it("treats % and _ in a search as literal characters", async () => {
    const res = await list(get(`/api/admin/enquiries?search=%25`), {} as never);
    expect(
      (await res.json()).items.every((r: { last_name: string }) => r.last_name.includes("%")),
    ).toBe(true);
  });

  it("422s on an unknown status or band, 401 without a session", async () => {
    expect((await list(get(`/api/admin/enquiries?status=handled`), {} as never)).status).toBe(422);
    expect((await list(get(`/api/admin/enquiries?band=urgent`), {} as never)).status).toBe(422);
    const anon = new NextRequest("http://localhost:3000/api/admin/enquiries");
    expect((await list(anon, {} as never)).status).toBe(401);
  });
});

describe("GET /api/admin/enquiries/:id", () => {
  it("returns every field and the snapshot as she saw it, and audits the view", async () => {
    const { id } = await enquiry({ wedding: "2027-02-14", channel: "viber" });
    await sql`INSERT INTO enquiry_gowns VALUES (${id}, ${gownId}, 'Name She Saw', 450000, 'priced', 'PHP')`;

    const res = await open(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      id,
      message: "Secret message",
      email: `${id}@bride.test`,
      chat_channel: "viber",
      lead_time_notice: "Notice she saw",
      source: "social",
      status: "new",
      is_erased: false,
      gowns: [{ gown_id: gownId, name: "Name She Saw", price_minor: 450000, currency: "PHP" }],
    });
    const [audit] = await views(id);
    expect(audit!.actor_user_id).toBe(staffId);
    expect(audit!.occurred_at).toBeInstanceOf(Date);
    // Opening never marks it handled.
    const [row] = await sql`SELECT status FROM enquiries WHERE id = ${id}`;
    expect(row!.status).toBe("new");
  });

  it("audits every open, including a second staff member's", async () => {
    const { id } = await enquiry({ wedding: "2027-02-15" });
    await open(id);
    await open(id);
    expect(await views(id)).toHaveLength(2);
  });

  it("shows no channel for a bride who never tapped one, without marking anything failed", async () => {
    const { id } = await enquiry({ wedding: "2027-02-16", channel: null });
    const body = await (await open(id)).json();
    expect(body.chat_channel).toBeNull();
    expect(body.status).toBe("new");
  });

  it("shows who handled it, from the latest status_change to read, only while still read", async () => {
    const { id } = await enquiry({ wedding: "2027-02-17", status: "read" });
    await sql`
      INSERT INTO audit_log (id, occurred_at, actor_user_id, action, entity_type, entity_id, detail)
      VALUES (${randomUUID()}, '2026-10-10T10:00:00Z', ${staffId}, 'enquiry.status_change', 'enquiry', ${id}, '{"from":"new","to":"read"}')
    `;
    const body = await (await open(id)).json();
    expect(body.handled_by).toEqual({ id: staffId, name: "Inbox Test" });
    expect(body.handled_at).toBe("2026-10-10T10:00:00.000Z");
    const [row] = (await listOf("status=read")).items.filter((r: { id: string }) => r.id === id);
    expect(row.handled_by).toEqual({ id: staffId, name: "Inbox Test" });

    await sql`UPDATE enquiries SET status = 'new' WHERE id = ${id}`;
    expect((await (await open(id)).json()).handled_by).toBeNull();
  });

  it("404s an unknown id and writes no audit row", async () => {
    const id = randomUUID();
    expect((await open(id)).status).toBe(404);
    expect(await views(id)).toHaveLength(0);
  });
});
