import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hashPassword, verifyPassword } from "@/server/auth/password";
import { validateSession } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { MemoryAttemptStore } from "@/server/ratelimit/attempt-store";
import { processStaffInviteMail } from "@/server/mail/staff-invite-outbox";
import { signIn } from "@/server/services/auth";
import {
  confirmPasswordReset,
  PASSWORD_RESET_TOKEN_TTL_MS,
  requestPasswordReset,
} from "@/server/services/password-reset";

/** KBS-59 against real Postgres: the emailed token sets a new password exactly once. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const PASSWORD = "a-real-staff-password-42";
const NEW_PASSWORD = "brand-new-reset-passphrase-77";
const created: string[] = [];
let passwordHash: string;

async function makeStaff() {
  const id = randomUUID();
  const email = `confirm-${id}@kleibridal.test`;
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${id}, 'Confirm Staff', ${email}, ${passwordHash}, true)
  `;
  created.push(id);
  return { id, email };
}

/** Issue a token through the real request path and pull it out of the mail. */
async function issueToken(email: string, now: Date): Promise<string> {
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  await requestPasswordReset({ email }, { db, now: () => now });
  await processStaffInviteMail({ db, send: sendEmail, now: () => now });
  expect(sendEmail).toHaveBeenCalledOnce();
  const text = (sendEmail.mock.calls[0]![0] as { text: string }).text;
  return decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);
}

const hashOf = async (id: string) =>
  (
    await sql<{ password_hash: string }[]>`SELECT password_hash FROM staff_users WHERE id = ${id}`
  )[0]!.password_hash;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterAll(async () => {
  if (created.length) {
    await sql`DELETE FROM password_reset_tokens WHERE staff_user_id = ANY(${created})`;
    await sql`DELETE FROM audit_log WHERE entity_id = ANY(${created}) OR actor_user_id = ANY(${created})`;
    await sql`DELETE FROM sessions WHERE staff_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

describe("staff password-reset confirm (KBS-59)", () => {
  it("sets the password once, revokes every session, audits, notifies; reuse is refused", async () => {
    const staff = await makeStaff();
    const signed = await signIn(
      { email: staff.email, password: PASSWORD, ip: "198.51.100.9", userAgent: "vitest" },
      { db, store: new MemoryAttemptStore() },
    );
    if (!signed.ok) throw new Error(signed.reason);
    const now = new Date();
    const token = await issueToken(staff.email, now);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const input = { token, newPassword: NEW_PASSWORD, ip: "203.0.113.7", userAgent: "vitest" };

    const first = await confirmPasswordReset(input, { db, sendEmail, now: () => now });

    expect(first).toEqual({ ok: true, revokedSessions: 1 });
    expect(await verifyPassword(await hashOf(staff.id), NEW_PASSWORD)).toBe(true);
    expect(await validateSession(db, signed.token, now)).toBeNull();
    const [audit] = await sql<{ ip: string; detail: unknown }[]>`
      SELECT host(ip) AS ip, detail FROM audit_log
      WHERE entity_id = ${staff.id} AND action = 'staff.password_reset'
    `;
    expect(audit).toMatchObject({ ip: "203.0.113.7", detail: { revoked_sessions: 1 } });
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: staff.email });

    const reused = await confirmPasswordReset(
      { ...input, newPassword: "another-attempt-passphrase-99" },
      { db, sendEmail, now: () => now },
    );
    expect(reused).toEqual({ ok: false, reason: "invalid_token" });
    expect(await verifyPassword(await hashOf(staff.id), NEW_PASSWORD)).toBe(true);
  });

  it("refuses an expired, a superseded and an unknown token without changing the password", async () => {
    const staff = await makeStaff();
    const issuedAt = new Date();
    const superseded = await issueToken(staff.email, issuedAt);
    const live = await issueToken(staff.email, issuedAt);
    const sendEmail = vi.fn();
    const attempt = (token: string, at: Date) =>
      confirmPasswordReset(
        { token, newPassword: NEW_PASSWORD, ip: null, userAgent: null },
        { db, sendEmail, now: () => at },
      );

    const expired = new Date(issuedAt.getTime() + PASSWORD_RESET_TOKEN_TTL_MS + 1);
    expect(await attempt(live, expired)).toEqual({ ok: false, reason: "invalid_token" });
    expect(await attempt(superseded, issuedAt)).toEqual({ ok: false, reason: "invalid_token" });
    expect(await attempt("B".repeat(43), issuedAt)).toEqual({ ok: false, reason: "invalid_token" });
    expect(await hashOf(staff.id)).toBe(passwordHash);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects a common password and leaves the token usable", async () => {
    const staff = await makeStaff();
    const now = new Date();
    const token = await issueToken(staff.email, now);
    const deps = { db, sendEmail: vi.fn().mockResolvedValue(undefined), now: () => now };

    const weak = await confirmPasswordReset(
      { token, newPassword: "password1234", ip: null, userAgent: null },
      deps,
    );
    expect(weak.ok).toBe(false);
    expect(await hashOf(staff.id)).toBe(passwordHash);

    const retry = await confirmPasswordReset(
      { token, newPassword: NEW_PASSWORD, ip: null, userAgent: null },
      deps,
    );
    expect(retry.ok).toBe(true);
  });
});
