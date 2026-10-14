import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as passwordRoute } from "../../../app/api/auth/password/route";
import { hashPassword } from "@/server/auth/password";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_TOUCH_INTERVAL_MS,
  createSession,
  hashSessionToken,
  revokeAllSessionsForUser,
  validateSession,
} from "@/server/auth/session";
import { db } from "@/server/db/client";
import { MemoryAttemptStore } from "@/server/ratelimit/attempt-store";
import { csrfHeaders } from "../csrf-headers";
import {
  changePassword,
  resetPassword,
  setStaffActive,
  signIn,
  signOutEverywhere,
} from "@/server/services/auth";

/**
 * KBS-27-2 against real Postgres 17: idle timeout, absolute cap, rotation,
 * and revocation on disable, password change, reset and "sign out
 * everywhere". Accounts are created per test and removed afterwards.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

const PASSWORD = "a-real-staff-password-42";
const NEW_PASSWORD = "a-brand-new-password-77";
const MINUTE = 60_000;
const created: string[] = [];
let passwordHash: string;

async function makeStaff() {
  const email = `staff-${randomUUID()}@kleibridal.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO staff_users (id, name, email, password_hash)
    VALUES (${randomUUID()}, 'Test Staff', ${email}, ${passwordHash})
    RETURNING id
  `;
  created.push(row!.id);
  return { id: row!.id, email };
}

async function signedIn(staff: { email: string }, now?: () => Date) {
  const result = await signIn(
    { email: staff.email, password: PASSWORD, ip: "198.51.100.7", userAgent: "vitest" },
    { db, store: new MemoryAttemptStore(), ...(now ? { now } : {}) },
  );
  if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
  return result.token;
}

async function lastSeen(token: string) {
  const [row] = await sql<{ last_seen_at: Date }[]>`
    SELECT last_seen_at FROM sessions WHERE token_hash = ${hashSessionToken(token)}
  `;
  return row!.last_seen_at;
}

async function liveSessions(staffUserId: string) {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM sessions
    WHERE staff_user_id = ${staffUserId} AND revoked_at IS NULL
  `;
  return row!.count;
}

async function auditActions(staffUserId: string) {
  const rows = await sql<{ action: string }[]>`
    SELECT action FROM audit_log WHERE entity_id = ${staffUserId} ORDER BY occurred_at, id
  `;
  return rows.map((r) => r.action);
}

function passwordRequest(token: string, body: unknown) {
  return new NextRequest("http://localhost:3000/api/auth/password", {
    method: "POST",
    headers: {
      ...csrfHeaders(`${SESSION_COOKIE}=${token}`),
      "content-type": "application/json",
      "x-real-ip": "198.51.100.8",
    },
    body: JSON.stringify(body),
  });
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

describe("account disable (AC-ADM-27) — the test that proves the architecture", () => {
  it("rejects a signed-in staff member's VERY NEXT request once disabled, not at expiry", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    expect(await validateSession(db, token)).not.toBeNull();

    // The session is hours from any idle timeout and 14 days from its cap.
    await setStaffActive({ staffUserId: staff.id, isActive: false, actorUserId: null });

    expect(await validateSession(db, token)).toBeNull();
    // ...and a real authenticated endpoint refuses that cookie on the next call.
    const response = await passwordRoute(
      passwordRequest(token, { current_password: PASSWORD, new_password: NEW_PASSWORD }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a revoked (signed-out) cookie replayed on a real route with 401", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    await sql`UPDATE sessions SET revoked_at = now() WHERE token_hash = ${hashSessionToken(token)}`;
    const response = await passwordRoute(
      passwordRequest(token, { current_password: PASSWORD, new_password: NEW_PASSWORD }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("is immediate through the is_active join alone, even with no revoke step", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    await sql`UPDATE staff_users SET is_active = false WHERE id = ${staff.id}`;
    expect(await validateSession(db, token)).toBeNull();
  });

  it("also revokes the rows, so re-enabling does not revive a leaver's old cookies", async () => {
    const staff = await makeStaff();
    const a = await signedIn(staff);
    const b = await signedIn(staff);

    const { revokedSessions } = await setStaffActive({
      staffUserId: staff.id,
      isActive: false,
      actorUserId: null,
    });
    expect(revokedSessions).toBe(2);
    await setStaffActive({ staffUserId: staff.id, isActive: true, actorUserId: null });

    expect(await validateSession(db, a)).toBeNull();
    expect(await validateSession(db, b)).toBeNull();
    expect(await auditActions(staff.id)).toEqual(
      expect.arrayContaining(["staff.disable", "staff.enable"]),
    );
  });
});

describe("lifetime: 24h sliding idle timeout + 14-day absolute cap", () => {
  it("expires a session left idle for 24 hours", async () => {
    const staff = await makeStaff();
    const t0 = new Date();
    const idle = await signedIn(staff, () => t0);
    const active = await signedIn(staff, () => t0);

    const before = new Date(t0.getTime() + SESSION_IDLE_TIMEOUT_MS - MINUTE);
    const after = new Date(t0.getTime() + SESSION_IDLE_TIMEOUT_MS + MINUTE);
    expect(await validateSession(db, active, before)).not.toBeNull();
    expect(await validateSession(db, idle, after)).toBeNull();
  });

  it("slides: activity within each 24h keeps the session alive past 24h", async () => {
    const staff = await makeStaff();
    const t0 = new Date();
    const token = await signedIn(staff, () => t0);

    const t1 = new Date(t0.getTime() + 20 * 60 * MINUTE);
    expect(await validateSession(db, token, t1)).not.toBeNull();
    expect((await lastSeen(token)).getTime()).toBe(t1.getTime());

    const t2 = new Date(t1.getTime() + 20 * 60 * MINUTE); // 40h after sign-in
    expect(await validateSession(db, token, t2)).not.toBeNull();
  });

  it("touches last_seen_at at most once per 5 minutes", async () => {
    const staff = await makeStaff();
    const t0 = new Date();
    const token = await signedIn(staff, () => t0);

    const soon = new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS - 1000);
    await validateSession(db, token, soon);
    expect((await lastSeen(token)).getTime()).toBe(t0.getTime());

    const later = new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS);
    await validateSession(db, token, later);
    expect((await lastSeen(token)).getTime()).toBe(later.getTime());
  });

  it("ends a session used every day at the 14-day cap, whatever its activity", async () => {
    const staff = await makeStaff();
    const t0 = new Date();
    const token = await signedIn(staff, () => t0);

    // Used every 20 hours, so the idle timeout never fires.
    let t = t0.getTime() + 20 * 60 * MINUTE;
    while (t < t0.getTime() + SESSION_ABSOLUTE_TTL_MS) {
      expect(await validateSession(db, token, new Date(t))).not.toBeNull();
      t += 20 * 60 * MINUTE;
    }
    const lastUse = t - 20 * 60 * MINUTE;
    const pastCap = new Date(t0.getTime() + SESSION_ABSOLUTE_TTL_MS + MINUTE);
    expect(pastCap.getTime() - lastUse).toBeLessThan(SESSION_IDLE_TIMEOUT_MS);
    expect(await validateSession(db, token, pastCap)).toBeNull();
  });

  it("enforces the cap from created_at even if expires_at was written later", async () => {
    const staff = await makeStaff();
    const t0 = new Date();
    const token = await signedIn(staff, () => t0);
    await sql`
      UPDATE sessions SET expires_at = expires_at + interval '30 days'
      WHERE token_hash = ${hashSessionToken(token)}
    `;
    const pastCap = new Date(t0.getTime() + SESSION_ABSOLUTE_TTL_MS + MINUTE);
    await sql`
      UPDATE sessions SET last_seen_at = ${new Date(pastCap.getTime() - MINUTE)}
      WHERE token_hash = ${hashSessionToken(token)}
    `;
    expect(await validateSession(db, token, pastCap)).toBeNull();
  });
});

describe("password change: rotation + revoke every other session", () => {
  it("revokes the other sessions, rotates this one, and the new password works", async () => {
    const staff = await makeStaff();
    const phone = await signedIn(staff);
    const laptop = await signedIn(staff);
    const attacker = await signedIn(staff);

    const result = await changePassword({
      token: laptop,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      ip: null,
      userAgent: "vitest",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revokedOtherSessions).toBe(2);

    expect(await validateSession(db, phone)).toBeNull();
    expect(await validateSession(db, attacker)).toBeNull();
    // Rotated: the pre-change cookie is dead, the new one is live.
    expect(await validateSession(db, laptop)).toBeNull();
    expect(result.token).not.toBe(laptop);
    expect((await validateSession(db, result.token))?.staff.id).toBe(staff.id);
    expect(await liveSessions(staff.id)).toBe(1);

    const old = await signIn(
      { email: staff.email, password: PASSWORD, ip: "198.51.100.9", userAgent: null },
      { db, store: new MemoryAttemptStore() },
    );
    expect(old).toEqual({ ok: false, reason: "invalid_credentials" });
    const fresh = await signIn(
      { email: staff.email, password: NEW_PASSWORD, ip: "198.51.100.9", userAgent: null },
      { db, store: new MemoryAttemptStore() },
    );
    expect(fresh.ok).toBe(true);
    expect(await auditActions(staff.id)).toContain("staff.password_change");
  });

  it("changes nothing when the current password is wrong", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    const other = await signedIn(staff);

    const result = await changePassword({
      token,
      currentPassword: "not-the-password",
      newPassword: NEW_PASSWORD,
      ip: null,
      userAgent: null,
    });
    expect(result).toEqual({ ok: false, reason: "wrong_current_password" });
    expect(await validateSession(db, token)).not.toBeNull();
    expect(await validateSession(db, other)).not.toBeNull();
  });

  it("route: 204 with a rotated cookie; the request's own cookie no longer works", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);

    const response = await passwordRoute(
      passwordRequest(token, { current_password: PASSWORD, new_password: NEW_PASSWORD }),
    );
    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^kbs_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie.toLowerCase()).toContain("httponly");
    const rotated = setCookie.split(";")[0]!.split("=")[1]!;
    expect(rotated).not.toBe(token);
    expect(await validateSession(db, token)).toBeNull();
    expect(await validateSession(db, rotated)).not.toBeNull();
  });

  it("rejects reusing current temporary password before changing state", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    await sql`UPDATE staff_users SET temp_password_expires_at = now() + interval '72 hours' WHERE id = ${staff.id}`;

    const result = await changePassword({
      token,
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
      ip: null,
      userAgent: null,
    });
    expect(result).toEqual({ ok: false, reason: "same_password" });
    expect(await validateSession(db, token)).not.toBeNull();
    const [row] =
      await sql`SELECT temp_password_expires_at FROM staff_users WHERE id = ${staff.id}`;
    expect(row!.temp_password_expires_at).not.toBeNull();
  });

  it("route: 422 naming the field for reusing current password", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    const response = await passwordRoute(
      passwordRequest(token, { current_password: PASSWORD, new_password: PASSWORD }),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error.fields).toHaveProperty("new_password");
  });

  it("route: 422 naming the field for a wrong current password or a short new one", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);

    const wrong = await passwordRoute(
      passwordRequest(token, { current_password: "nope", new_password: NEW_PASSWORD }),
    );
    expect(wrong.status).toBe(422);
    expect((await wrong.json()).error.fields).toHaveProperty("current_password");

    const short = await passwordRoute(
      passwordRequest(token, { current_password: PASSWORD, new_password: "short" }),
    );
    expect(short.status).toBe(422);
    expect((await short.json()).error.fields).toHaveProperty("new_password");
  });
});

describe("password reset and sign out everywhere", () => {
  it("a reset revokes EVERY session of the account and clears any lock", async () => {
    const staff = await makeStaff();
    const a = await signedIn(staff);
    const b = await signedIn(staff);
    await sql`UPDATE staff_users SET locked_until = now() + interval '1 hour' WHERE id = ${staff.id}`;

    const result = await resetPassword({
      staffUserId: staff.id,
      newPassword: NEW_PASSWORD,
      actorUserId: null,
      ip: "203.0.113.9",
    });
    expect(result).toEqual({ ok: true, revokedSessions: 2 });
    const [audit] = await sql<{ ip: string | null }[]>`
      SELECT host(ip) AS ip FROM audit_log
      WHERE entity_id = ${staff.id} AND action = 'staff.password_reset'
    `;
    expect(audit!.ip).toBe("203.0.113.9");
    expect(await validateSession(db, a)).toBeNull();
    expect(await validateSession(db, b)).toBeNull();
    const [row] = await sql<{ locked_until: Date | null }[]>`
      SELECT locked_until FROM staff_users WHERE id = ${staff.id}
    `;
    expect(row!.locked_until).toBeNull();
    expect(await auditActions(staff.id)).toContain("staff.password_reset");
  });

  it("refuses a reset to a password shorter than 12 characters", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    expect(
      await resetPassword({ staffUserId: staff.id, newPassword: "short", actorUserId: null }),
    ).toEqual({ ok: false, reason: "weak_password" });
    expect(await validateSession(db, token)).not.toBeNull();
  });

  it("rejects a reset password derived from the target staff email", async () => {
    const staff = await makeStaff();
    const token = await signedIn(staff);
    expect(
      await resetPassword({
        staffUserId: staff.id,
        newPassword: `${staff.email.split("@", 1)[0]}-reset!`,
        actorUserId: null,
      }),
    ).toEqual({ ok: false, reason: "password_too_common" });
    expect(await validateSession(db, token)).not.toBeNull();
  });

  it("sign out everywhere revokes every session, including the caller's", async () => {
    const staff = await makeStaff();
    const a = await signedIn(staff);
    const b = await signedIn(staff);
    expect(await signOutEverywhere(a)).toBe(true);
    expect(await validateSession(db, a)).toBeNull();
    expect(await validateSession(db, b)).toBeNull();
    expect(await signOutEverywhere(a)).toBe(false);
  });

  it("revokeAllSessionsForUser leaves other accounts' sessions alone", async () => {
    const mine = await makeStaff();
    const theirs = await makeStaff();
    const theirToken = await signedIn(theirs);
    await createSession(db, { staffUserId: mine.id, ip: null, userAgent: null });

    expect(await revokeAllSessionsForUser(db, mine.id, new Date())).toBe(1);
    expect(await validateSession(db, theirToken)).not.toBeNull();
  });
});
