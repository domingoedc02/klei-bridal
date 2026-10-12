import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/server/mail/send", () => ({ sendTransactionalEmail: mail.send }));

import { hashPassword, verifyPassword } from "@/server/auth/password";
import { db } from "@/server/db/client";
import { MemoryAttemptStore } from "@/server/ratelimit/attempt-store";
import { changePassword, resetPassword, signIn } from "@/server/services/auth";

/** KBS-60 against real Postgres: the "password changed" mail follows a committed change only. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const PASSWORD = "a-real-staff-password-42";
const NEW_PASSWORD = "brand-new-staff-passphrase-77";
const created: string[] = [];
let passwordHash: string;

async function makeStaff() {
  const id = randomUUID();
  const email = `mail-${id}@kleibridal.test`;
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${id}, 'Mail Staff', ${email}, ${passwordHash}, true)
  `;
  created.push(id);
  return { id, email };
}

async function tokenFor(email: string) {
  const r = await signIn(
    { email, password: PASSWORD, ip: "198.51.100.9", userAgent: "vitest" },
    { db, store: new MemoryAttemptStore() },
  );
  if (!r.ok) throw new Error(r.reason);
  return r.token;
}

const hashOf = async (id: string) =>
  (
    await sql<{ password_hash: string }[]>`SELECT password_hash FROM staff_users WHERE id = ${id}`
  )[0]!.password_hash;

const failedMailRows = async (id: string) =>
  (
    await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE entity_id = ${id} AND action = 'mail.password_changed_failed'
    `
  )[0]!.count;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  mail.send.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  if (created.length) {
    await sql`DELETE FROM audit_log WHERE entity_id = ANY(${created}) OR actor_user_id = ANY(${created})`;
    await sql`DELETE FROM sessions WHERE staff_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

describe("password-changed notification (KBS-60)", () => {
  it("change: one mail after commit with Manila time, /24 IP, user agent, no secrets", async () => {
    const staff = await makeStaff();
    const token = await tokenFor(staff.email);
    // Proves post-commit: when the mail is sent, the new hash is already visible to another connection.
    mail.send.mockImplementation(async () => {
      expect(await verifyPassword(await hashOf(staff.id), NEW_PASSWORD)).toBe(true);
    });

    const result = await changePassword(
      {
        token,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        ip: "203.0.113.57",
        userAgent: "Mozilla/5.0 vitest",
      },
      { db, now: () => new Date("2026-10-09T04:30:00.000Z"), store: new MemoryAttemptStore() },
    );

    expect(result.ok).toBe(true);
    expect(mail.send).toHaveBeenCalledOnce();
    const message = mail.send.mock.calls[0]![0] as { to: string; text: string; html: string };
    expect(message.to).toBe(staff.email);
    expect(message.text).toContain("October 9, 2026 at 12:30 PM GMT+8");
    expect(message.text).toContain("203.0.113.0/24");
    expect(message.text).not.toContain("203.0.113.57");
    expect(message.text).toContain("Mozilla/5.0 vitest");
    const body = message.text + message.html;
    for (const secret of [PASSWORD, NEW_PASSWORD, token]) expect(body).not.toContain(secret);
  });

  it("reset: one mail with a /48 IPv6 prefix", async () => {
    const staff = await makeStaff();

    const result = await resetPassword(
      {
        staffUserId: staff.id,
        newPassword: NEW_PASSWORD,
        actorUserId: null,
        ip: "2001:db8:abcd:12::1",
      },
      { db },
    );

    expect(result.ok).toBe(true);
    expect(mail.send).toHaveBeenCalledOnce();
    const message = mail.send.mock.calls[0]![0] as { to: string; text: string };
    expect(message.to).toBe(staff.email);
    expect(message.text).toContain("2001:db8:abcd::/48");
  });

  it("provider failure: the change persists and mail.password_changed_failed is audited", async () => {
    const staff = await makeStaff();
    const token = await tokenFor(staff.email);
    mail.send.mockRejectedValue(new Error("provider down"));

    const changed = await changePassword(
      {
        token,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        ip: "203.0.113.5",
        userAgent: null,
      },
      { db, store: new MemoryAttemptStore() },
    );
    expect(changed.ok).toBe(true);
    expect(await verifyPassword(await hashOf(staff.id), NEW_PASSWORD)).toBe(true);

    const reset = await resetPassword(
      { staffUserId: staff.id, newPassword: "a-third-staff-passphrase-31", actorUserId: null },
      { db },
    );
    expect(reset.ok).toBe(true);
    expect(await failedMailRows(staff.id)).toBe(2);
  });

  it("wrong current password: no mail", async () => {
    const staff = await makeStaff();
    const token = await tokenFor(staff.email);

    const result = await changePassword(
      {
        token,
        currentPassword: "not-the-password-00",
        newPassword: NEW_PASSWORD,
        ip: null,
        userAgent: null,
      },
      { db, store: new MemoryAttemptStore() },
    );

    expect(result.ok).toBe(false);
    expect(mail.send).not.toHaveBeenCalled();
    expect(await hashOf(staff.id)).toBe(passwordHash);
  });
});
