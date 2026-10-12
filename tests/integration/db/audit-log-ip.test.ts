import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as loginRoute } from "../../../app/api/auth/login/route";
import { hashPassword } from "@/server/auth/password";
import { db } from "@/server/db/client";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import { csrfHeaders } from "../csrf-headers";

/** KBS-62: audit_log.ip records the proxy-trusted client IP, or NULL. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const PASSWORD = "a-real-staff-password-42";
const created: string[] = [];
let passwordHash: string;

async function makeStaff() {
  const email = `audit-ip-${randomUUID()}@kleibridal.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${randomUUID()}, 'Audit IP', ${email}, ${passwordHash}, true)
    RETURNING id
  `;
  created.push(row!.id);
  return { id: row!.id, email };
}

async function signInVia(email: string, ipHeaders: Record<string, string>) {
  const res = await loginRoute(
    new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { ...csrfHeaders(), "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ password_change_required: false });
}

async function auditIp(staffId: string) {
  const [row] = await sql<{ ip: string | null }[]>`
    SELECT host(ip) AS ip FROM audit_log
    WHERE actor_user_id = ${staffId} AND action = 'staff.sign_in'
  `;
  return row!.ip;
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  if (created.length > 0) {
    await sql`DELETE FROM sessions WHERE staff_user_id = ANY(${created})`;
    await sql`DELETE FROM audit_log WHERE actor_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

describe("audit_log.ip (KBS-62)", () => {
  it("is a nullable inet column", async () => {
    const [col] = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'audit_log' AND column_name = 'ip'
    `;
    expect(col).toEqual({ data_type: "inet", is_nullable: "YES" });
  });

  it("records the proxy-appended hop, not a spoofed X-Forwarded-For prefix", async () => {
    const staff = await makeStaff();
    await signInVia(staff.email, { "x-forwarded-for": "1.2.3.4, 203.0.113.77" });
    expect(await auditIp(staff.id)).toBe("203.0.113.77");
  });

  it("prefers Traefik's X-Real-IP, IPv6 included", async () => {
    const staff = await makeStaff();
    await signInVia(staff.email, { "x-real-ip": "2001:db8::42", "x-forwarded-for": "1.2.3.4" });
    expect(await auditIp(staff.id)).toBe("2001:db8::42");
  });

  it("writes NULL, without error, when no IP header is present", async () => {
    const staff = await makeStaff();
    await signInVia(staff.email, {});
    expect(await auditIp(staff.id)).toBeNull();
  });

  it("inetOrNull never passes a non-IP string to inet", () => {
    expect(inetOrNull("unknown")).toBeNull();
    expect(inetOrNull("1.2.3.4; DROP")).toBeNull();
    expect(inetOrNull(null)).toBeNull();
    expect(inetOrNull("198.51.100.1")).toBe("198.51.100.1");
  });
});
