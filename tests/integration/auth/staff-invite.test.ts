import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { confirmStaffInvite } from "@/server/services/password-reset";
import { INVITE_TOKEN_TTL_MS, issueStaffInvite } from "@/server/services/staff-invite";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev",
  { max: 1 },
);
const created: string[] = [];
const OLD_PASSWORD = "legacy-password-42";
const NEW_PASSWORD = "invite-password-42";
let oldHash: string;

beforeAll(async () => {
  oldHash = await hashPassword(OLD_PASSWORD);
});

afterAll(async () => {
  if (created.length) {
    await sql`DELETE FROM password_reset_tokens WHERE staff_user_id = ANY(${created})`;
    await sql`DELETE FROM audit_log WHERE entity_id = ANY(${created}) OR actor_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

async function makeStaff(passwordHash: string | null = null) {
  const id = randomUUID();
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${id}, 'Invite Staff', ${`invite-${id}@kleibridal.test`}, ${passwordHash}, true)
  `;
  created.push(id);
  return id;
}

describe("staff invite tokens", () => {
  it("stores only hash, issues 24-hour invite, and accepts once", async () => {
    const id = await makeStaff();
    const now = new Date("2026-10-16T00:00:00Z");
    const invite = await issueStaffInvite(id, { db, now: () => now });
    expect(invite).toMatchObject({
      staffUserId: id,
      expiresAt: new Date(now.getTime() + INVITE_TOKEN_TTL_MS),
    });
    expect(invite!.rawToken).toHaveLength(43);
    const [row] =
      await sql`SELECT kind, token_hash, expires_at, used_at FROM password_reset_tokens WHERE staff_user_id = ${id}`;
    expect(row).toMatchObject({ kind: "invite", used_at: null });
    expect(row!.token_hash).not.toContain(invite!.rawToken);

    const result = await confirmStaffInvite(
      { token: invite!.rawToken, newPassword: NEW_PASSWORD, ip: "203.0.113.1", userAgent: "test" },
      { db, now: () => now },
    );
    expect(result).toEqual({ ok: true, revokedSessions: 0 });
    const reused = await confirmStaffInvite(
      { token: invite!.rawToken, newPassword: "another-password-42", ip: null, userAgent: null },
      { db, now: () => now },
    );
    expect(reused).toEqual({ ok: false, reason: "invalid_token" });
    const [staff] = await sql`SELECT password_hash FROM staff_users WHERE id = ${id}`;
    expect(await verifyPassword(staff!.password_hash, NEW_PASSWORD)).toBe(true);
  });

  it("revokes prior invite before replacement", async () => {
    const id = await makeStaff();
    const now = new Date();
    const first = await issueStaffInvite(id, { db, now: () => now });
    const second = await issueStaffInvite(id, { db, now: () => new Date(now.getTime() + 1000) });
    expect(first!.rawToken).not.toBe(second!.rawToken);
    expect(
      await confirmStaffInvite(
        { token: first!.rawToken, newPassword: NEW_PASSWORD, ip: null, userAgent: null },
        { db },
      ),
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rejects invite for disabled staff", async () => {
    const id = await makeStaff(oldHash);
    await sql`UPDATE staff_users SET is_active = false WHERE id = ${id}`;
    expect(await issueStaffInvite(id, { db })).toBeNull();
  });

  it("rolls back token, password, sessions, and audit when update claims zero rows", async () => {
    const id = await makeStaff(oldHash);
    const sessionA = await createSession(db, { staffUserId: id, ip: null, userAgent: "rollback-a" });
    const sessionB = await createSession(db, { staffUserId: id, ip: null, userAgent: "rollback-b" });
    const now = new Date("2026-10-16T00:30:00Z");
    await sql`
      UPDATE staff_users
      SET temp_password_expires_at = ${new Date(now.getTime() + 60 * 60_000)}
      WHERE id = ${id}
    `;
    const invite = await issueStaffInvite(id, { db, now: () => now });
    await sql`
      CREATE OR REPLACE FUNCTION kbs_test_skip_staff_update() RETURNS trigger AS $fn$
      BEGIN
        IF OLD.id::text = TG_ARGV[0] THEN RETURN NULL; END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `;
    await sql`
      CREATE TRIGGER kbs_test_skip_staff_update
      BEFORE UPDATE ON staff_users FOR EACH ROW
      EXECUTE FUNCTION kbs_test_skip_staff_update(${id})
    `;
    try {
      await expect(
        confirmStaffInvite(
          { token: invite!.rawToken, newPassword: NEW_PASSWORD, ip: null, userAgent: null },
          { db, now: () => now },
        ),
      ).resolves.toEqual({ ok: false, reason: "invalid_token" });
    } finally {
      await sql`DROP TRIGGER IF EXISTS kbs_test_skip_staff_update ON staff_users`;
      await sql`DROP FUNCTION IF EXISTS kbs_test_skip_staff_update()`;
    }
    const [token] = await sql`
      SELECT used_at FROM password_reset_tokens WHERE staff_user_id = ${id} AND kind = 'invite'
    `;
    const [staff] = await sql`SELECT password_hash FROM staff_users WHERE id = ${id}`;
    const sessions = await sql`SELECT revoked_at FROM sessions WHERE staff_user_id = ${id}`;
    const audit = await sql`
      SELECT action FROM audit_log WHERE entity_id = ${id} AND action = 'staff.invite_accept'
    `;
    expect(token?.used_at).toBeNull();
    expect(await verifyPassword(staff!.password_hash, OLD_PASSWORD)).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.revoked_at === null)).toBe(true);
    expect(audit).toHaveLength(0);
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
  });

  it("allows one concurrent redemption and leaves loser without partial mutation", async () => {
    const id = await makeStaff(oldHash);
    const sessionA = await createSession(db, { staffUserId: id, ip: null, userAgent: "a" });
    const sessionB = await createSession(db, { staffUserId: id, ip: null, userAgent: "b" });
    const now = new Date("2026-10-16T01:00:00Z");
    const invite = await issueStaffInvite(id, { db, now: () => now });
    const input = { token: invite!.rawToken, newPassword: NEW_PASSWORD, ip: null, userAgent: null };
    const results = await Promise.all([
      confirmStaffInvite(input, { db, now: () => now }),
      confirmStaffInvite(input, { db, now: () => now }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "invalid_token" },
    ]);
    const [token] = await sql`
      SELECT used_at FROM password_reset_tokens
      WHERE staff_user_id = ${id} AND kind = 'invite'
    `;
    expect(token!.used_at).not.toBeNull();
    const [staff] = await sql`SELECT password_hash FROM staff_users WHERE id = ${id}`;
    expect(await verifyPassword(staff!.password_hash, NEW_PASSWORD)).toBe(true);
    const sessions = await sql`SELECT id, revoked_at FROM sessions WHERE staff_user_id = ${id} ORDER BY id`;
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.revoked_at !== null)).toBe(true);
    const audit = await sql`
      SELECT action FROM audit_log WHERE entity_id = ${id} AND action = 'staff.invite_accept'
    `;
    expect(audit).toHaveLength(1);
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
  });
});
