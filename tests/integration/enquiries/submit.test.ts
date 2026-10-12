import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { POST } from "../../../app/api/enquiries/route";
import { middleware } from "../../../middleware";
import { env } from "@/config/env";
import { db } from "@/server/db/client";
import { submitEnquiry, type EnquiryInput } from "@/server/services/enquiries";
import { todayIn } from "@/shared/dates";
import { csrfHeaders } from "../csrf-headers";

/** KBS-17-1 against real Postgres 17 + Valkey: POST /api/enquiries. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

const gownIds: string[] = [];
const emails: string[] = [];

async function gown(
  status: "draft" | "published" | "archived" = "published",
  price: number | null = 8_500_000,
) {
  const id = randomUUID();
  gownIds.push(id);
  await sql`
    INSERT INTO gowns (id, slug, name, status, price_status, price_minor)
    VALUES (${id}, ${`kbs171-${id}`}, ${`Gown ${id.slice(0, 4)}`}, ${status},
            ${price === null ? "on_request" : "priced"}, ${price})
  `;
  return id;
}

function weeksOut(weeks: number) {
  const today = todayIn("Asia/Manila");
  return new Date(Date.parse(`${today}T00:00:00Z`) + weeks * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function input(overrides: Partial<EnquiryInput> = {}): EnquiryInput {
  const email = `bride-${randomUUID()}@kleibridal.test`;
  emails.push(email);
  return {
    first_name: "Maricel",
    last_name: "Santos",
    contact_number: "+63 917 123 4567",
    email,
    wedding_date: weeksOut(40),
    message: null,
    gown_ids: [],
    ...overrides,
  };
}

let ipSeq = 0;
// One IP per request so the 5/10-min budget (budgets.enquirySubmit) never trips.
function ip() {
  ipSeq += 1;
  return `198.51.${100 + Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3000/api/enquiries", {
      method: "POST",
      headers: { ...csrfHeaders(), "content-type": "application/json", "x-real-ip": ip() },
      body: JSON.stringify(body),
    }),
  );
}

async function rowsFor(email: string) {
  return sql`SELECT * FROM enquiries WHERE email = ${email}`;
}

async function waitForMailStatuses(email: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [row] = await rowsFor(email);
    if (row?.studio_email_status === "sent" && row.bride_email_status === "sent") return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("enquiry mail statuses did not become sent");
}

afterAll(async () => {
  await sql`DELETE FROM enquiries WHERE email = ANY(${emails})`;
  await sql`DELETE FROM gowns WHERE id = ANY(${gownIds}::uuid[])`;
  await sql.end();
  await db.$client.end();
});

describe("POST /api/enquiries (KBS-17-1)", () => {
  it("201: reference, short link, band; stores only the token hash", async () => {
    const g = await gown();
    const body = input({ gown_ids: [g], wedding_date: weeksOut(10) });
    const res = await post(body);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.reference).toMatch(/^KB-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect(json.short_link_url).toMatch(/\/e\/[A-Za-z0-9_-]{43}$/);
    expect(json.lead_time_band).toBe("rush");
    expect(json.notice_shown).toBeTruthy();

    const token = json.short_link_url.split("/e/")[1];
    const [row] = await rowsFor(body.email);
    expect(row!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row!.reference).toBe(json.reference);
    expect(row!.lead_time_band_shown).toBe("rush");
    expect(row!.lead_time_notice_shown).toBe(json.notice_shown);
    expect(row!.status).toBe("new");
    expect(row!.contact_number).toBe("+63 917 123 4567");
    expect((await waitForMailStatuses(body.email)).studio_email_status).toBe("sent");
  });

  it("first visit: GET /enquire mints kbs_csrf, then the POST that echoes it gets 201 (no injected cookie)", async () => {
    const page = middleware(new NextRequest("http://localhost:3000/enquire"));
    const setCookie = page.headers.get("set-cookie") ?? "";
    const token = /kbs_csrf=([^;]+)/.exec(setCookie)?.[1];
    expect(token).toBeTruthy();
    // What EnquiryForm does: read document.cookie, send it back as x-csrf-token.
    const res = await POST(
      new NextRequest("http://localhost:3000/api/enquiries", {
        method: "POST",
        headers: {
          origin: new URL(env.SITE_URL).origin,
          cookie: `kbs_csrf=${token}`,
          "x-csrf-token": token!,
          "content-type": "application/json",
          "x-real-ip": ip(),
        },
        body: JSON.stringify(input()),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("CSRF is enforced", async () => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/enquiries", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip() },
        body: JSON.stringify(input()),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rate-limits to 5 per 10 minutes per IP (429 on the 6th)", async () => {
    const fixed = `203.0.113.${Date.now() % 250}`;
    const send = () =>
      POST(
        new NextRequest("http://localhost:3000/api/enquiries", {
          method: "POST",
          headers: { ...csrfHeaders(), "content-type": "application/json", "x-real-ip": fixed },
          body: JSON.stringify(input()),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await send()).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("zero gowns is a valid enquiry (AC-ENQ-04)", async () => {
    const body = input();
    expect((await post(body)).status).toBe(201);
    const [row] = await rowsFor(body.email);
    const links = await sql`SELECT 1 FROM enquiry_gowns WHERE enquiry_id = ${row!.id}`;
    expect(links).toHaveLength(0);
  });

  it("rejects unknown and unpublished gowns with 422, writing nothing (AC-ENQ-16/17)", async () => {
    const live = await gown();
    for (const bad of [randomUUID(), await gown("draft"), await gown("archived")]) {
      const body = input({ gown_ids: [live, bad] });
      const res = await post(body);
      expect(res.status).toBe(422);
      expect((await res.json()).error.fields).toEqual({
        gown_ids: "One or more gowns are no longer available.",
      });
      expect(await rowsFor(body.email)).toHaveLength(0);
    }
  });

  it("dedupes a repeated gown id to one row (AC-ENQ-18)", async () => {
    const g = await gown();
    const body = input({ gown_ids: [g, g, g.toUpperCase()] });
    expect((await post(body)).status).toBe(201);
    const [row] = await rowsFor(body.email);
    expect(await sql`SELECT 1 FROM enquiry_gowns WHERE enquiry_id = ${row!.id}`).toHaveLength(1);
  });

  it("rejects 51 ids and malformed ids with 4xx and writes nothing (AC-ENQ-19/20)", async () => {
    const many = input({ gown_ids: Array.from({ length: 1000 }, () => randomUUID()) });
    expect((await post(many)).status).toBe(422);
    for (const bad of ["' OR 1=1 --", "../../etc/passwd", null, { a: 1 }]) {
      const body = { ...input(), gown_ids: [bad] };
      expect((await post(body)).status).toBe(422);
      expect(await rowsFor(body.email)).toHaveLength(0);
    }
  });

  it("422s (not 500s) on NUL or CRLF and writes nothing", async () => {
    for (const bad of [{ message: "hi\u0000there" }, { first_name: "Ana\r\nBcc: x@y.z" }]) {
      const body = input(bad);
      const res = await post(body);
      expect(res.status).toBe(422);
      expect(await rowsFor(body.email)).toHaveLength(0);
    }
  });

  it("ignores a forged source / utm (AC-ENQ-21)", async () => {
    const body = { ...input(), source: "social", utm_source: "facebook", referrer_host: "x.test" };
    expect((await post(body)).status).toBe(201);
    const [row] = await rowsFor(body.email);
    expect(row).toMatchObject({ source: "direct", utm_source: null, referrer_host: null });
  });

  it("snapshots name and price; a later edit does not rewrite it (AC-ENQ-22)", async () => {
    const g = await gown("published", 8_500_000);
    const onRequest = await gown("published", null);
    const body = input({ gown_ids: [g, onRequest] });
    expect((await post(body)).status).toBe(201);
    await sql`UPDATE gowns SET price_minor = 9500000, name = 'Renamed' WHERE id = ${g}`;
    const [row] = await rowsFor(body.email);
    const snap = await sql`
      SELECT gown_id, gown_name_snapshot, price_minor_snapshot, price_status_snapshot, currency_snapshot
      FROM enquiry_gowns WHERE enquiry_id = ${row!.id} ORDER BY price_minor_snapshot NULLS LAST
    `;
    expect(snap).toEqual([
      {
        gown_id: g,
        gown_name_snapshot: `Gown ${g.slice(0, 4)}`,
        price_minor_snapshot: "8500000",
        price_status_snapshot: "priced",
        currency_snapshot: "PHP",
      },
      {
        gown_id: onRequest,
        gown_name_snapshot: `Gown ${onRequest.slice(0, 4)}`,
        price_minor_snapshot: null,
        price_status_snapshot: "on_request",
        currency_snapshot: "PHP",
      },
    ]);
  });

  it("rejects a past date with 422 and accepts a far one (AC-ENQ-08)", async () => {
    const past = input({ wedding_date: weeksOut(-1) });
    const res = await post(past);
    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.fields)).toEqual(["wedding_date"]);
    expect(await rowsFor(past.email)).toHaveLength(0);
    expect((await post(input({ wedding_date: weeksOut(5 * 52) }))).status).toBe(201);
    expect((await post(input({ wedding_date: "2027-02-30" }))).status).toBe(422);
  });

  it("stores the date exactly as sent (AC-ENQ-06)", async () => {
    const body = input({ wedding_date: "2030-06-12" });
    await post(body);
    const [row] =
      await sql`SELECT wedding_date::text AS d FROM enquiries WHERE email = ${body.email}`;
    expect(row!.d).toBe("2030-06-12");
  });

  it("stores international numbers as typed (AC-ENQ-27) and rejects junk (AC-ENQ-28)", async () => {
    for (const n of ["+971 50 123 4567", "+1 (415) 555-0132", "+81 90-1234-5678"]) {
      const body = input({ contact_number: n });
      expect((await post(body)).status).toBe(201);
      expect((await rowsFor(body.email))[0]!.contact_number).toBe(n);
    }
    for (const n of ["abc", "", "<script>alert(1)</script>"]) {
      const res = await post(input({ contact_number: n }));
      expect(res.status).toBe(422);
      expect(JSON.stringify(await res.json())).not.toContain("<script>");
    }
  });
});

describe("post-commit enquiry mail", () => {
  it("stores both sent statuses without changing the successful response", async () => {
    const body = input();
    const res = await post(body);
    expect(res.status).toBe(201);
    await expect(waitForMailStatuses(body.email)).resolves.toMatchObject({
      studio_email_status: "sent",
      bride_email_status: "sent",
    });
  });

  it("does not dispatch mail for a duplicate enquiry", async () => {
    const body = input();
    const first = await post(body);
    const duplicate = await post(body);
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    const rows = await rowsFor(body.email);
    expect(rows).toHaveLength(1);
    await expect(waitForMailStatuses(body.email)).resolves.toMatchObject({
      studio_email_status: "sent",
      bride_email_status: "sent",
    });
  });
});

describe("double submission (AC-ENQ-23..26)", () => {
  it("a sequential repeat returns the existing reference, one row", async () => {
    const g = await gown();
    const body = input({ gown_ids: [g] });
    const first = await post(body);
    const again = await post({ ...body, email: body.email.toUpperCase(), gown_ids: [g, g] });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    const a = await first.json();
    const b = await again.json();
    expect(b.reference).toBe(a.reference);
    expect(b.short_link_url).toBeNull();
    expect(b.lead_time_band).toBe(a.lead_time_band);
    expect(await rowsFor(body.email)).toHaveLength(1);
  });

  it("concurrent identical POSTs create exactly one row (AC-ENQ-24)", async () => {
    const g1 = await gown();
    const g2 = await gown();
    const body = input({ gown_ids: [g1, g2] });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        submitEnquiry({ ...body, gown_ids: i % 2 ? [g2, g1] : [g1, g2] }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.reference)).size).toBe(1);
    expect(await rowsFor(body.email)).toHaveLength(1);
  });

  it("a different gown set, or zero vs some, is a new enquiry (AC-ENQ-26)", async () => {
    const g1 = await gown();
    const g2 = await gown();
    const body = input({ gown_ids: [g1] });
    const a = await submitEnquiry(body);
    const b = await submitEnquiry({ ...body, gown_ids: [g1, g2] });
    const c = await submitEnquiry({ ...body, gown_ids: [] });
    expect([a.created, b.created, c.created]).toEqual([true, true, true]);
    expect(await rowsFor(body.email)).toHaveLength(3);
  });

  it("outside the 5-minute window the same enquiry is created again", async () => {
    const body = input();
    const a = await submitEnquiry(body);
    await sql`UPDATE enquiries SET created_at = now() - interval '6 minutes' WHERE reference = ${a.reference}`;
    const b = await submitEnquiry(body);
    expect(b.created).toBe(true);
    expect(b.reference).not.toBe(a.reference);
  });
});
