import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as loginRoute } from "../../../app/api/auth/login/route";
import { POST as logoutRoute } from "../../../app/api/auth/logout/route";
import { hashPassword } from "@/server/auth/password";
import { SESSION_COOKIE, hashSessionToken, validateSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { MemoryAttemptStore } from "@/server/ratelimit/attempt-store";
import { csrfHeaders } from "../csrf-headers";
import { signIn, signOut } from "@/server/services/auth";

/**
 * KBS-27-1 against real Postgres 17: sign-in, sign-out, lockout and the
 * no-enumeration rule. Every account is created here with a unique email
 * and removed afterwards (audit rows first — they reference the account).
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

const PASSWORD = "a-real-staff-password-42";
const created: string[] = [];
let passwordHash: string;

async function makeStaff(overrides: { isActive?: boolean } = {}) {
  const email = `staff-${randomUUID()}@kleibridal.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${randomUUID()}, 'Test Staff', ${email}, ${passwordHash}, ${overrides.isActive ?? true})
    RETURNING id
  `;
  created.push(row!.id);
  return { id: row!.id, email };
}

async function sessionCount(staffUserId: string) {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM sessions WHERE staff_user_id = ${staffUserId}
  `;
  return row!.count;
}

function deps(store = new MemoryAttemptStore(), now?: () => Date) {
  return { db, store, ...(now ? { now } : {}) };
}

function ip() {
  return `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  if (created.length > 0) {
    await sql`DELETE FROM audit_log WHERE actor_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

describe("sign-in (KBS-27-1)", () => {
  it("stores only the SHA-256 of the token, and the session validates", async () => {
    const staff = await makeStaff();
    const result = await signIn(
      { email: staff.email.toUpperCase(), password: PASSWORD, ip: ip(), userAgent: "vitest" },
      deps(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await sql`SELECT * FROM sessions WHERE staff_user_id = ${staff.id}`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.token_hash).toBe(hashSessionToken(result.token));
    // The raw token is in no column of the row.
    expect(JSON.stringify(row)).not.toContain(result.token);
    expect(row.revoked_at).toBeNull();
    expect(row.user_agent).toBe("vitest");

    const session = await validateSession(db, result.token);
    expect(session?.staff.id).toBe(staff.id);
  });

  it("creates a NEW row and token on every sign-in", async () => {
    const staff = await makeStaff();
    const a = await signIn(
      { email: staff.email, password: PASSWORD, ip: ip(), userAgent: null },
      deps(),
    );
    const b = await signIn(
      { email: staff.email, password: PASSWORD, ip: ip(), userAgent: null },
      deps(),
    );
    expect(a.ok && b.ok && a.token !== b.token).toBe(true);
    expect(await sessionCount(staff.id)).toBe(2);
  });

  it("attributes the sign-in to the named person in audit_log (AC-ADM-26)", async () => {
    const staff = await makeStaff();
    await signIn({ email: staff.email, password: PASSWORD, ip: ip(), userAgent: null }, deps());
    const audit = await sql`
      SELECT action, entity_id FROM audit_log WHERE actor_user_id = ${staff.id}
    `;
    expect(audit).toEqual([{ action: "staff.sign_in", entity_id: staff.id }]);
  });
});

describe("no user enumeration, including timing", () => {
  it("answers an unknown email, a wrong password and a disabled account identically", async () => {
    const active = await makeStaff();
    const disabled = await makeStaff({ isActive: false });
    const attempt = (email: string, password: string) =>
      signIn({ email, password, ip: ip(), userAgent: null }, deps());

    const unknown = await attempt(`nobody-${randomUUID()}@kleibridal.test`, PASSWORD);
    const wrong = await attempt(active.email, "wrong-password");
    const off = await attempt(disabled.email, PASSWORD);
    expect(unknown).toEqual({ ok: false, reason: "invalid_credentials" });
    expect(wrong).toEqual(unknown);
    expect(off).toEqual(unknown);

    expect(await sessionCount(disabled.id)).toBe(0);
  });

  it("runs a full argon2id verify for an unknown email (no short-circuit)", async () => {
    const staff = await makeStaff();
    const time = async (email: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await signIn({ email, password: "wrong", ip: ip(), userAgent: null }, deps());
        samples.push(performance.now() - t0);
      }
      return samples.sort((x, y) => x - y)[2]!;
    };
    const wrongPassword = await time(staff.email);
    const unknownEmail = await time(`nobody-${randomUUID()}@kleibridal.test`);
    // A short-circuit would be ~1 ms against tens of ms for argon2id; the
    // bound is loose on purpose so a noisy CI runner cannot flake it.
    expect(unknownEmail).toBeGreaterThan(wrongPassword * 0.5);
  });

  it("returns the same 401 body from the route for an unknown email and a wrong password", async () => {
    const staff = await makeStaff();
    const post = (email: string, password: string) =>
      loginRoute(
        new NextRequest("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: {
            ...csrfHeaders(),
            "content-type": "application/json",
            "x-real-ip": ip(),
            "x-request-id": "r1",
          },
          body: JSON.stringify({ email, password }),
        }),
      );
    const a = await post(`nobody-${randomUUID()}@kleibridal.test`, PASSWORD);
    const b = await post(staff.email, "wrong-password");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const body = await a.json();
    expect(body).toEqual({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid email or password.",
        request_id: "r1",
      },
    });
    expect(await b.json()).toEqual(body);
    expect(a.headers.get("set-cookie")).toBeNull();
  });
});

describe("lockout (AC-ADM-29)", () => {
  it("after 10 failures from varying IPs, refuses the CORRECT password until backoff clears", async () => {
    const staff = await makeStaff();
    const store = new MemoryAttemptStore();
    let now = new Date();
    const d = deps(store, () => now);

    for (let i = 0; i < 10; i++) {
      await signIn(
        { email: staff.email, password: `guess-${i}`, ip: `203.0.113.${i + 1}`, userAgent: null },
        d,
      );
    }

    const eleventh = await signIn(
      { email: staff.email, password: PASSWORD, ip: "203.0.113.200", userAgent: null },
      d,
    );
    expect(eleventh).toMatchObject({ ok: false, reason: "account_locked" });
    if (eleventh.ok || eleventh.reason !== "account_locked") return;
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
    expect(eleventh.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);

    // The row keeps a durable copy for the admin screen, but it locks only
    // while the attempt store also holds the lock: a store that lost its
    // keys must treat a real account exactly like an unknown email, or the
    // lockout becomes an enumeration oracle (security-eng, PR #13).
    const [row] = await sql`SELECT locked_until FROM staff_users WHERE id = ${staff.id}`;
    expect(row!.locked_until).not.toBeNull();
    const unknown = `nobody-${randomUUID()}@kleibridal.test`;
    const lostStore = deps(new MemoryAttemptStore(), () => now);
    const [real, ghost] = await Promise.all([
      signIn(
        { email: staff.email, password: "wrong", ip: "203.0.113.201", userAgent: null },
        lostStore,
      ),
      signIn(
        { email: unknown, password: "wrong", ip: "203.0.113.203", userAgent: null },
        lostStore,
      ),
    ]);
    expect(real).toEqual(ghost);
    expect(real).toMatchObject({ ok: false, reason: "invalid_credentials" });

    // Once the backoff has passed, the right password works and resets it.
    now = new Date(now.getTime() + 31 * 60_000);
    const later = await signIn(
      { email: staff.email, password: PASSWORD, ip: "203.0.113.202", userAgent: null },
      d,
    );
    expect(later.ok).toBe(true);
    const [reset] =
      await sql`SELECT failed_login_count, locked_until FROM staff_users WHERE id = ${staff.id}`;
    expect(reset).toEqual({ failed_login_count: 0, locked_until: null });
  });

  it("answers a locked account with 429 ACCOUNT_LOCKED, a clear message and Retry-After", async () => {
    const staff = await makeStaff();
    // Lock it the real way, through the route and the production Valkey store.
    const attempt = (password: string) =>
      loginRoute(
        new NextRequest("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { ...csrfHeaders(), "content-type": "application/json", "x-real-ip": ip() },
          body: JSON.stringify({ email: staff.email, password }),
        }),
      );
    for (let i = 0; i < 5; i++) expect((await attempt(`guess-${i}`)).status).toBe(401);
    const res = await loginRoute(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { ...csrfHeaders(), "content-type": "application/json", "x-real-ip": ip() },
        body: JSON.stringify({ email: staff.email, password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(240);
    const body = await res.json();
    expect(body.error.code).toBe("ACCOUNT_LOCKED");
    expect(body.error.message).toMatch(/Try again in 5 minutes/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("sign-out (KBS-27-1)", () => {
  it("sets revoked_at, and a replay of the old cookie is rejected", async () => {
    const staff = await makeStaff();
    const result = await signIn(
      { email: staff.email, password: PASSWORD, ip: ip(), userAgent: null },
      deps(),
    );
    if (!result.ok) throw new Error("sign-in failed");

    await signOut(result.token, { db });

    const [row] =
      await sql`SELECT revoked_at FROM sessions WHERE token_hash = ${hashSessionToken(result.token)}`;
    expect(row!.revoked_at).not.toBeNull();
    expect(await validateSession(db, result.token)).toBeNull();
    const audit =
      await sql`SELECT action FROM audit_log WHERE actor_user_id = ${staff.id} ORDER BY occurred_at`;
    expect(audit.map((a) => a.action)).toEqual(["staff.sign_in", "staff.sign_out"]);
  });

  it("route: sets the cookie on sign-in, and sign-out revokes the row then clears it", async () => {
    const staff = await makeStaff();
    const login = await loginRoute(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { ...csrfHeaders(), "content-type": "application/json", "x-real-ip": ip() },
        body: JSON.stringify({ email: staff.email, password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(204);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^kbs_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/Path=\//);
    // 14 days, less the milliseconds between the row's created_at and the response.
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
    expect(maxAge).toBeGreaterThan(14 * 86_400 - 5);
    expect(maxAge).toBeLessThanOrEqual(14 * 86_400);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    const token = setCookie.split(";")[0]!.split("=")[1]!;

    const logout = await logoutRoute(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: csrfHeaders(`${SESSION_COOKIE}=${token}`),
      }),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toMatch(/kbs_session=;.*Max-Age=0/);
    expect(await validateSession(db, token)).toBeNull();
  });
});

describe("a disabled account (AC-ADM-27, at the lookup)", () => {
  it("rejects the session on the next lookup via the is_active join", async () => {
    const staff = await makeStaff();
    const result = await signIn(
      { email: staff.email, password: PASSWORD, ip: ip(), userAgent: null },
      deps(),
    );
    if (!result.ok) throw new Error("sign-in failed");
    expect(await validateSession(db, result.token)).not.toBeNull();

    await sql`UPDATE staff_users SET is_active = false WHERE id = ${staff.id}`;
    expect(await validateSession(db, result.token)).toBeNull();
  });

  it("rejects malformed and unknown tokens without a query error", async () => {
    expect(await validateSession(db, "short")).toBeNull();
    expect(await validateSession(db, "A".repeat(43))).toBeNull();
    expect(await validateSession(db, undefined)).toBeNull();
  });
});
