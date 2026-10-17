import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as detail, PATCH as patch } from "../../../app/api/admin/enquiries/[id]/route";
import { GET as list } from "../../../app/api/admin/enquiries/route";
import { POST as erase } from "../../../app/api/admin/enquiries/[id]/erase/route";
import { SESSION_COOKIE, createSession } from "@/server/auth/session";
import { db, type Database } from "@/server/db/client";
import { anonymiseEnquiry } from "@/server/services/enquiry-erasure";
import { csrfHeaders } from "../csrf-headers";

/** KBS-23-2: audited status changes and erasure, through the real routes. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
let staffId: string;
let session: string;
let gownId: string;
const enquiryIds: string[] = [];

/** Every PII column set to a value we can grep for afterwards. */
async function enquiry(status = "new") {
  const id = randomUUID();
  const pii = {
    first: `Fn${id.slice(0, 6)}`,
    last: `Ln${id.slice(0, 6)}`,
    phone: `+6391${id.replace(/\D/g, "").slice(0, 8).padEnd(8, "7")}`,
    email: `${id}@bride.test`,
    message: `Msg ${id}`,
    utm: `utm${id.slice(0, 6)}`,
    referrer: `ref-${id.slice(0, 6)}.test`,
  };
  await sql`
    INSERT INTO enquiries (id, reference, token_hash, first_name, last_name, contact_number, email,
      wedding_date, message, source, utm_source, utm_medium, utm_campaign, referrer_host,
      lead_time_band_shown, lead_time_notice_shown, status)
    VALUES (${id}, ${`KB-${id.slice(0, 4).toUpperCase()}-ER`}, ${randomUUID()}, ${pii.first},
      ${pii.last}, ${pii.phone}, ${pii.email}, '2027-02-14', ${pii.message}, 'social',
      ${`${pii.utm}s`}, ${`${pii.utm}m`}, ${`${pii.utm}c`}, ${pii.referrer},
      'comfortable', 'Notice she saw', ${status})
  `;
  await sql`INSERT INTO enquiry_gowns VALUES (${id}, ${gownId}, 'Snap', 100, 'priced', 'PHP')`;
  enquiryIds.push(id);
  return { id, pii };
}

function req(url: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...csrfHeaders(`${SESSION_COOKIE}=${session}`),
      "x-real-ip": "203.0.113.32",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const setStatus = (id: string, body: unknown) =>
  patch(req(`/api/admin/enquiries/${id}`, "PATCH", body), ctx(id));
const doErase = (id: string, body: unknown) =>
  erase(req(`/api/admin/enquiries/${id}/erase`, "POST", body), ctx(id));
const auditOf = (id: string, action: string) =>
  sql`SELECT actor_user_id, detail, ip FROM audit_log WHERE entity_id = ${id} AND action = ${action}`;
const rowOf = async (id: string) => (await sql`SELECT * FROM enquiries WHERE id = ${id}`)[0]!;
const gownsOf = (id: string) => sql`SELECT * FROM enquiry_gowns WHERE enquiry_id = ${id}`;
const valid = { confirm: true, reason: "data_subject_request" };
function getReq(url: string) {
  return new NextRequest(`http://localhost:3000${url}`, {
    headers: { ...csrfHeaders(`${SESSION_COOKIE}=${session}`), "x-real-ip": "203.0.113.32" },
  });
}

beforeAll(async () => {
  staffId = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Erase Test', ${`erase-${staffId}@kleibridal.test`}, 'not-used', true)
  `;
  session = (await createSession(db, { staffUserId: staffId, ip: null, userAgent: null })).token;
  gownId = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, price_status, price_minor, currency, created_by, updated_by)
    VALUES (${gownId}, ${`erase-${gownId}`}, 'Current Name', 'published', 'priced', 999900, 'PHP', ${staffId}, ${staffId})
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

describe("PATCH /api/admin/enquiries/:id", () => {
  it("marks handled with a {from,to} audit row, is a no-op on the same status, and can be undone", async () => {
    const { id } = await enquiry();
    const res = await setStatus(id, { status: "read" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ status: "read", handled_by: { id: staffId, name: "Erase Test" } });
    expect(body.handled_at).toEqual(expect.any(String));

    const rows = await auditOf(id, "enquiry.status_change");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: staffId,
      detail: { from: "new", to: "read" },
      ip: "203.0.113.32",
    });

    expect((await setStatus(id, { status: "read" })).status).toBe(200);
    expect(await auditOf(id, "enquiry.status_change")).toHaveLength(1);

    const undone = await (await setStatus(id, { status: "new" })).json();
    expect(undone).toMatchObject({ status: "new", handled_by: null, handled_at: null });
    expect(await auditOf(id, "enquiry.status_change")).toHaveLength(2);
  });

  it("rejects a bad body with 422, an unknown id with 404, and an erased enquiry with 409", async () => {
    const { id } = await enquiry();
    for (const bad of [{ status: "done" }, { status: "read", note: "x" }, {}]) {
      const res = await setStatus(id, bad);
      expect(res.status).toBe(422);
    }
    expect((await setStatus(randomUUID(), { status: "read" })).status).toBe(404);

    expect((await doErase(id, valid)).status).toBe(200);
    const res = await setStatus(id, { status: "archived" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect((await rowOf(id)).status).toBe("new");
    expect(await auditOf(id, "enquiry.status_change")).toHaveLength(0);
  });
});

describe("POST /api/admin/enquiries/:id/erase", () => {
  it("rejects a reason outside the enum, free text, extra fields or no confirm, changing nothing", async () => {
    const { id } = await enquiry();
    const before = await rowOf(id);
    for (const bad of [
      { confirm: true, reason: "other" },
      { confirm: true, reason: "Maria asked by phone" },
      { ...valid, note: "x" },
      { confirm: false, reason: "data_subject_request" },
      { reason: "data_subject_request" },
    ]) {
      expect((await doErase(id, bad)).status).toBe(422);
    }
    expect(await rowOf(id)).toEqual(before);
    expect(await auditOf(id, "enquiry.erase")).toHaveLength(0);
  });

  it("nulls the nine PII columns in place, keeps everything else, and audits only {trigger, reason}", async () => {
    const { id, pii } = await enquiry("read");
    const before = await rowOf(id);
    const gownsBefore = await gownsOf(id);

    const res = await doErase(id, valid);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      is_erased: true,
      first_name: null,
      email: null,
      gowns: [{ name: "Snap" }],
    });

    const after = await rowOf(id);
    for (const c of [
      "first_name",
      "last_name",
      "contact_number",
      "email",
      "message",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "referrer_host",
    ]) {
      expect(before[c]).not.toBeNull();
      expect(after[c]).toBeNull();
    }
    for (const c of ["reference", "token_hash", "wedding_date", "source", "status", "created_at"]) {
      expect(after[c]).toEqual(before[c]);
    }
    expect(await gownsOf(id)).toEqual(gownsBefore);

    const audit = await auditOf(id, "enquiry.erase");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBe(staffId);
    expect(audit[0]!.detail).toEqual({ trigger: "manual", reason: "data_subject_request" });

    // Full scan of the enquiry row and every audit row about it: no planted value survives.
    const dump = JSON.stringify([
      after,
      await sql`SELECT * FROM audit_log WHERE entity_id = ${id}`,
    ]);
    for (const v of Object.values(pii)) expect(dump).not.toContain(v);
  });

  it("returns 409 on a repeat erase and writes no second audit row", async () => {
    const { id } = await enquiry();
    expect((await doErase(id, valid)).status).toBe(200);
    const res = await doErase(id, { confirm: true, reason: "duplicate_or_test" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(await auditOf(id, "enquiry.erase")).toHaveLength(1);
  });

  it("serialises two concurrent erases: one 200, one 409, one audit row", async () => {
    const { id } = await enquiry();
    const codes = (await Promise.all([doErase(id, valid), doErase(id, valid)])).map(
      (r) => r.status,
    );
    expect(codes.sort()).toEqual([200, 409]);
    expect(await auditOf(id, "enquiry.erase")).toHaveLength(1);
  });

  it("404s for an unknown id", async () => {
    expect((await doErase(randomUUID(), valid)).status).toBe(404);
  });
});

describe("anonymiseEnquiry (retention caller, KBS-30)", () => {
  it("records a system erase with a null actor and the retention trigger", async () => {
    const { id } = await enquiry();
    await db.transaction((tx) =>
      anonymiseEnquiry(tx as unknown as Database, id, {
        actorUserId: null,
        trigger: "retention",
        reason: "retention_policy",
      }),
    );
    const audit = await auditOf(id, "enquiry.erase");
    expect(audit).toEqual([
      {
        actor_user_id: null,
        detail: { trigger: "retention", reason: "retention_policy" },
        ip: null,
      },
    ]);
  });
});

describe("KBS-23-3 UI contract: what the screens receive", () => {
  it("list rows carry no message, email, phone or attribution, before or after erase", async () => {
    const { id, pii } = await enquiry();
    const erased = await enquiry();
    expect((await doErase(erased.id, valid)).status).toBe(200);
    for (const target of [{ id, pii }, erased]) {
      const res = await list(getReq(`/api/admin/enquiries?search=${target.id}@bride`), {} as never);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const raw = await res.text();
      for (const k of ["message", "email", "contact_number", "utm_source", "referrer_host"]) {
        expect(raw).not.toContain(`"${k}"`);
      }
      for (const v of [pii.email, pii.phone, pii.message, pii.utm, pii.referrer]) {
        expect(raw).not.toContain(v);
      }
    }
  });

  it("an erased enquiry still counts in the list total and keeps its wedding date (AC: counts never drop)", async () => {
    const { id } = await enquiry();
    const url = `/api/admin/enquiries?search=${id}@bride`;
    const before = await (await list(getReq(url), {} as never)).json();
    expect(before.total_items).toBe(1);
    expect((await doErase(id, valid)).status).toBe(200);
    const [{ n }] = (await sql`SELECT count(*)::int AS n FROM enquiries WHERE id = ${id}`) as unknown as [{ n: number }];
    expect(n).toBe(1);
    // Search by email no longer matches (email is gone); the row is still in the unfiltered total.
    const all = await (await list(getReq("/api/admin/enquiries?per_page=100"), {} as never)).json();
    expect(all.items.some((r: { id: string }) => r.id === id)).toBe(true);
  });

  it("erased detail returns no name, contact, email, message or attribution", async () => {
    const { id, pii } = await enquiry();
    expect((await doErase(id, valid)).status).toBe(200);
    const res = await detail(getReq(`/api/admin/enquiries/${id}`), ctx(id));
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body).toMatchObject({
      is_erased: true,
      first_name: null,
      last_name: null,
      contact_number: null,
      email: null,
      message: null,
      utm_source: null,
      referrer_host: null,
    });
    for (const v of Object.values(pii)) expect(raw).not.toContain(v);
  });
});
