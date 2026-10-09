import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as passwordRoute } from "../../../app/api/auth/password/route";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { SESSION_COOKIE, validateSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { MemoryAttemptStore, type AttemptStore } from "@/server/ratelimit/attempt-store";
import { csrfHeaders } from "../csrf-headers";
import { changePassword, signIn } from "@/server/services/auth";

/**
 * KBS-63-1 against real Postgres 17 + Valkey 8: wrong current-password
 * guesses on POST /api/auth/password are capped per user.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

const PASSWORD = "a-real-staff-password-42";
const NEW_PASSWORD = "brand-new-staff-passphrase-77";
const created: string[] = [];
let passwordHash: string;

async function makeStaff() {
  const email = `staff-${randomUUID()}@kleibridal.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${randomUUID()}, 'Test Staff', ${email}, ${passwordHash}, true)
    RETURNING id
  `;
  created.push(row!.id);
  return { id: row!.id, email };
}

async function signedIn(staff: { email: string }) {
  const result = await signIn(
    { email: staff.email, password: PASSWORD, ip: "198.51.100.9", userAgent: "vitest" },
    { db, store: new MemoryAttemptStore() },
  );
  if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
  return result.token;
}

const post = (token: string, current: string) =>
  passwordRoute(
    new NextRequest("http://localhost:3000/api/auth/password", {
      method: "POST",
      headers: {
        ...csrfHeaders(`${SESSION_COOKIE}=${token}`),
        "content-type": "application/json",
        "x-real-ip": `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
      },
      body: JSON.stringify({ current_password: current, new_password: NEW_PASSWORD }),
    }),
  );

async function hashOf(id: string) {
  const [row] = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM staff_users WHERE id = ${id}
  `;
  return row!.password_hash;
}

async function lockedRows(id: string) {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_log
    WHERE entity_id = ${id} AND action = 'auth.password_change_locked'
  `;
  return row!.count;
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  if (created.length > 0) {
    await sql`DELETE FROM audit_log WHERE entity_id = ANY(${created}) OR actor_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

describe("change-password lockout (KBS-63)", () => {
  it("5th wrong guess: 429 + Retry-After, revokes that session, one audit row; others 429 even with the right password; revoked 401", async () => {
    const staff = await makeStaff();
    const thief = await signedIn(staff);
    const owner = await signedIn(staff);

    for (let i = 0; i < 4; i++) expect((await post(thief, `guess-${i}`)).status).toBe(422);
    const fifth = await post(thief, "guess-4");
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await fifth.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
    expect(await validateSession(db, thief)).toBeNull();
    expect(await lockedRows(staff.id)).toBe(1);

    const right = await post(owner, PASSWORD);
    expect(right.status).toBe(429);
    expect(await verifyPassword(await hashOf(staff.id), PASSWORD)).toBe(true);
    expect(await lockedRows(staff.id)).toBe(1);

    expect((await post(thief, PASSWORD)).status).toBe(401);
  });

  it("a correct change after 3 failures resets the counter", async () => {
    const staff = await makeStaff();
    const store = new MemoryAttemptStore();
    const token = await signedIn(staff);
    const attempt = (current: string, password = NEW_PASSWORD, t = token) =>
      changePassword(
        { token: t, currentPassword: current, newPassword: password, ip: null, userAgent: null },
        { db, store },
      );

    for (let i = 0; i < 3; i++) {
      expect(await attempt(`guess-${i}`)).toEqual({ ok: false, reason: "wrong_current_password" });
    }
    const ok = await attempt(PASSWORD);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(await store.get(`pwchg:fail:${staff.id}`)).toBeNull();

    // A fresh window: 4 more wrong guesses are still only 422s.
    for (let i = 0; i < 4; i++) {
      expect(await attempt(`again-${i}`, "another-long-passphrase-99", ok.token)).toEqual({
        ok: false,
        reason: "wrong_current_password",
      });
    }
  });

  it("fails closed when the attempt store is down: unavailable, password unchanged", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    const down = new Proxy({} as AttemptStore, {
      get: () => () => Promise.reject(new Error("ECONNREFUSED")),
    });
    for (const current of [PASSWORD, "wrong-guess"]) {
      const result = await changePassword(
        { token, currentPassword: current, newPassword: NEW_PASSWORD, ip: null, userAgent: null },
        { db, store: down },
      );
      expect(result).toEqual({ ok: false, reason: "unavailable" });
    }
    expect(await verifyPassword(await hashOf(staff.id), PASSWORD)).toBe(true);
    expect(await validateSession(db, token)).not.toBeNull();
  });
});
