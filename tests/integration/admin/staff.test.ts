import { randomUUID } from "node:crypto";
import { sql as dsql } from "drizzle-orm";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as staffRoute from "../../../app/api/admin/staff/[id]/route";
import { GET as list, POST as create } from "../../../app/api/admin/staff/route";
import { SESSION_COOKIE, createSession, validateSession } from "@/server/auth/session";
import { db, type Database } from "@/server/db/client";
import { updateStaff } from "@/server/services/admin-staff";
import { csrfHeaders } from "../csrf-headers";

/** KBS-24-1: staff list, rename, disable/enable through the real routes and DB. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const ids: string[] = [];
let adminId: string;
let adminToken: string;

async function staff(name = "Staff Member") {
  const id = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${id}, ${name}, ${`staff-${id}@kleibridal.test`}, 'secret-hash-value', true)`;
  ids.push(id);
  return id;
}

function req(url: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: {
      ...csrfHeaders(`${SESSION_COOKIE}=${adminToken}`),
      "x-real-ip": "203.0.113.40",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const patch = (id: string, body: unknown) =>
  staffRoute.PATCH(req(`/api/admin/staff/${id}`, "PATCH", body), {
    params: Promise.resolve({ id }),
  } as never);
const auditOf = (id: string) =>
  sql`SELECT action, actor_user_id, detail, ip FROM audit_log
      WHERE entity_type = 'staff_user' AND entity_id = ${id} ORDER BY occurred_at, action`;
const principal = (id: string) =>
  ({
    sessionId: randomUUID(),
    expiresAt: new Date(),
    staff: { id, name: "x", email: "x" },
  }) as const;

beforeAll(async () => {
  adminId = await staff("Admin Person");
  adminToken = (await createSession(db, { staffUserId: adminId, ip: null, userAgent: null })).token;
});

afterAll(async () => {
  await sql`DELETE FROM audit_log WHERE entity_id = ANY(${ids}) OR actor_user_id = ANY(${ids})`;
  await sql`DELETE FROM staff_users WHERE id = ANY(${ids})`;
  await sql.end();
  await db.$client.end();
});

describe("GET /api/admin/staff", () => {
  it("lists name, email, active state and last sign-in, never the hash; no-store", async () => {
    const id = await staff("Listed Person");
    const res = await list(req("/api/admin/staff"), {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw).not.toContain("secret-hash-value");
    expect(raw).not.toMatch(/password_hash|temp_password_expires_at|failed_login|locked_until/);
    const row = JSON.parse(raw).items.find((r: { id: string }) => r.id === id);
    expect(row).toEqual({
      id,
      name: "Listed Person",
      email: `staff-${id}@kleibridal.test`,
      is_active: true,
      password_change_pending: false,
      last_sign_in_at: null,
      created_at: expect.any(String),
    });
  });

  it("refuses without a session", async () => {
    const res = await list(new NextRequest("http://localhost:3000/api/admin/staff"), {} as never);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/staff", () => {
  it("creates with an Argon2id hash, 72-hour pending state, and no credential disclosure", async () => {
    const email = `created-${randomUUID()}@kleibridal.test`;
    const password = "A-long-temporary-password-42!";
    const input = { name: "Created Person", email, password };
    const res = await create(req("/api/admin/staff", "POST", input), {
      principal: principal(adminId),
      body: input,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      name: "Created Person",
      email,
      is_active: true,
      password_change_pending: true,
    });
    expect(JSON.stringify(body)).not.toContain(password);
    const [row] =
      await sql`SELECT password_hash, temp_password_expires_at FROM staff_users WHERE email = ${email}`;
    expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    expect(new Date(row!.temp_password_expires_at).getTime()).toBeGreaterThan(
      Date.now() + 71 * 60 * 60 * 1000,
    );
    ids.push(body.id);
    const [audit] =
      await sql`SELECT detail FROM audit_log WHERE entity_id = ${body.id} AND action = 'staff.create'`;
    expect(audit!.detail).toEqual({});
  });

  it("rejects missing or extra password before insert", async () => {
    const email = `invalid-${randomUUID()}@kleibridal.test`;
    const missing = { name: "Invalid", email };
    const extra = { name: "Invalid", email, password: "x", extra: true };
    expect(
      (
        await create(req("/api/admin/staff", "POST", missing), {
          principal: principal(adminId),
          body: missing as never,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await create(req("/api/admin/staff", "POST", extra), {
          principal: principal(adminId),
          body: extra as never,
        })
      ).status,
    ).toBe(422);
    const rows = await sql`SELECT id FROM staff_users WHERE email = ${email}`;
    expect(rows).toHaveLength(0);
  });
});

describe("PATCH /api/admin/staff/:id", () => {
  it("disable signs the person out on their very next request, audited; re-enable does not revive old sessions", async () => {
    const id = await staff();
    const { token } = await createSession(db, { staffUserId: id, ip: null, userAgent: null });
    expect(await validateSession(db, token)).not.toBeNull();

    const res = await patch(id, { is_active: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, is_active: false });
    expect(await validateSession(db, token)).toBeNull();
    const [s] = await sql`SELECT revoked_at FROM sessions WHERE staff_user_id = ${id}`;
    expect(s!.revoked_at).not.toBeNull();

    expect((await patch(id, { is_active: false })).status).toBe(200); // no-op
    expect(await (await patch(id, { is_active: true })).json()).toMatchObject({ is_active: true });
    expect(await validateSession(db, token)).toBeNull();

    expect(await auditOf(id)).toEqual([
      { action: "staff.disable", actor_user_id: adminId, detail: {}, ip: "203.0.113.40" },
      { action: "staff.enable", actor_user_id: adminId, detail: {}, ip: "203.0.113.40" },
    ]);
  });

  it("renames with an audit row that holds no name", async () => {
    const id = await staff("Old Name");
    const res = await patch(id, { name: "  New Name  " });
    expect(await res.json()).toMatchObject({ name: "New Name" });
    const rows = await auditOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "staff.rename", detail: {} });
  });

  it("resets an active account with a temporary password, revokes sessions, and audits without credentials", async () => {
    const id = await staff("Reset Target");
    const session = await createSession(db, { staffUserId: id, ip: null, userAgent: null });
    const temporary = "A-new-temporary-password-99!";
    const res = await patch(id, { password: temporary });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id, password_change_pending: true });
    expect(JSON.stringify(body)).not.toContain(temporary);
    expect(await validateSession(db, session.token)).toBeNull();
    const [row] =
      await sql`SELECT password_hash, temp_password_expires_at FROM staff_users WHERE id = ${id}`;
    expect(row!.password_hash).toMatch(/^\$argon2id\$/);
    expect(new Date(row!.temp_password_expires_at).getTime()).toBeGreaterThan(
      Date.now() + 71 * 60 * 60 * 1000,
    );
    const [audit] =
      await sql`SELECT detail FROM audit_log WHERE entity_id = ${id} AND action = 'staff.password_reset'`;
    expect(audit!.detail).toEqual({});
  });

  it("refuses self-disable with 409 and changes nothing", async () => {
    const res = await patch(adminId, { is_active: false });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("You cannot disable your own account.");
    expect(await validateSession(db, adminToken)).not.toBeNull();
    expect(await auditOf(adminId)).toHaveLength(0);
  });

  it("refuses to disable the last active account", async () => {
    const last = await staff();
    const other = await staff();
    // The shared dev DB holds other staff: make `last` the only active row
    // inside a transaction that is always rolled back.
    let refusal: unknown;
    const rollback = new Error("rollback");
    await db
      .transaction(async (tx) => {
        await tx.execute(
          dsql`UPDATE staff_users SET is_active = false WHERE is_active AND id <> ${last}`,
        );
        const t = tx as unknown as Database;
        refusal = await updateStaff(last, { is_active: false }, principal(other), null, t).catch(
          (e: unknown) => e,
        );
        throw rollback;
      })
      .catch((e: unknown) => {
        if (e !== rollback) throw e;
      });
    expect(refusal).toMatchObject({
      status: 409,
      message: "The last active account cannot be disabled.",
    });
    const [row] = await sql`SELECT is_active FROM staff_users WHERE id = ${last}`;
    expect(row!.is_active).toBe(true);
  });

  it("422 on unknown fields, empty body or blank name; 404 on unknown id; no DELETE", async () => {
    const id = await staff();
    for (const bad of [{}, { email: "x@y.z" }, { name: "   " }, { is_active: "no" }]) {
      expect((await patch(id, bad)).status).toBe(422);
    }
    expect((await patch(randomUUID(), { is_active: false })).status).toBe(404);
    expect("DELETE" in staffRoute).toBe(false);
  });
});
