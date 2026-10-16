import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hashPassword } from "@/server/auth/password";
import { db } from "@/server/db/client";
import {
  hashPasswordResetToken,
  PASSWORD_RESET_TOKEN_TTL_MS,
  requestPasswordReset,
} from "@/server/services/password-reset";
import { processStaffInviteMail } from "@/server/mail/staff-invite-outbox";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const PASSWORD = "a-real-staff-password-42";
const created: string[] = [];
let passwordHash: string;

async function makeStaff(isActive = true) {
  const id = randomUUID();
  const email = `reset-${id}@kleibridal.test`;
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${id}, 'Reset Staff', ${email}, ${passwordHash}, ${isActive})
  `;
  created.push(id);
  return { id, email };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

/** Newest outbox row for a staff member's reset tokens, so tests process exactly their own mail. */
async function outboxIdFor(staffId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    SELECT o.id FROM staff_mail_outbox o
    JOIN password_reset_tokens t ON t.id = o.token_id
    WHERE t.staff_user_id = ${staffId}
    ORDER BY o.created_at DESC LIMIT 1
  `;
  return row!.id;
}

afterAll(async () => {
  if (created.length) {
    await sql`DELETE FROM password_reset_tokens WHERE staff_user_id = ANY(${created})`;
    await sql`DELETE FROM audit_log WHERE entity_id = ANY(${created}) OR actor_user_id = ANY(${created})`;
    await sql`DELETE FROM staff_users WHERE id = ANY(${created})`;
  }
  await sql.end();
  await db.$client.end();
});

describe("staff password-reset request (KBS-59-1)", () => {
  it("returns the same neutral result for unknown, disabled and active addresses", async () => {
    const active = await makeStaff();
    const disabled = await makeStaff(false);
    const unknown = await requestPasswordReset({ email: `nobody-${randomUUID()}@kleibridal.test` }, { db });
    const off = await requestPasswordReset({ email: disabled.email }, { db });
    const found = await requestPasswordReset({ email: active.email }, { db });
    const send = vi.fn().mockResolvedValue(undefined);
    await processStaffInviteMail({ db, send, now: () => new Date(), outboxId: await outboxIdFor(active.id) });

    expect(unknown).toEqual({ accepted: true });
    expect(off).toEqual(unknown);
    expect(found).toEqual(unknown);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("queues provider failures for retry, then revokes token and audits terminal failure", async () => {
    const staff = await makeStaff();
    const now = new Date("2026-10-10T12:00:00.000Z");
    await requestPasswordReset({ email: staff.email }, { db, now: () => now });
    const [outbox] = await sql<{ id: string; token_id: string; status: string; attempts: number }[]>`
      SELECT id, token_id, status, attempts FROM staff_mail_outbox
      WHERE token_id IN (SELECT id FROM password_reset_tokens WHERE staff_user_id = ${staff.id})
    `;
    expect(outbox).toMatchObject({ status: "pending", attempts: 0 });
    const send = vi.fn(async () => { throw new Error("provider secret detail"); });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await processStaffInviteMail({ db, send, now: () => new Date(now.getTime() + attempt * 60_001), outboxId: outbox!.id });
    }
    const [failed] = await sql<{ status: string; attempts: number; payload: Buffer | null }[]>`
      SELECT status, attempts, payload FROM staff_mail_outbox WHERE id = ${outbox!.id}
    `;
    expect(failed).toMatchObject({ status: "failed", attempts: 3, payload: null });
    const [token] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM password_reset_tokens WHERE id = ${outbox!.token_id}
    `;
    expect(token!.revoked_at).not.toBeNull();
    const audit = await sql<{ action: string; detail: Record<string, unknown> }[]>`
      SELECT action, detail FROM audit_log WHERE entity_id = ${staff.id} AND action = 'auth.password_reset_mail_failed'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toEqual({ delivery: "failed", error_code: "provider_rejected" });
    expect(JSON.stringify(audit)).not.toContain("provider secret detail");
  });

  it("stores only a hash, expires after 30 minutes, and revokes the prior active token", async () => {
    const staff = await makeStaff();
    const sent: Array<{ text: string }> = [];
    const sendEmail = vi.fn(async (message: { text: string }) => {
      sent.push(message);
    });
    let now = new Date("2026-10-09T12:00:00.000Z");
    const deps = { db, sendEmail, now: () => now };

    await requestPasswordReset({ email: staff.email }, deps);
    await processStaffInviteMail({ db, send: sendEmail, now: () => now, outboxId: await outboxIdFor(staff.id) });
    await requestPasswordReset({ email: staff.email }, deps);
    await processStaffInviteMail({ db, send: sendEmail, now: () => now, outboxId: await outboxIdFor(staff.id) });
    expect(sent).toHaveLength(2);

    const firstRaw = /token=([^\s]+)/.exec(sent[0]!.text)![1]!;
    const secondRaw = /token=([^\s]+)/.exec(sent[1]!.text)![1]!;
    const firstToken = decodeURIComponent(firstRaw);
    const secondToken = decodeURIComponent(secondRaw);
    const rows = await sql<
      { token_hash: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }[]
    >`
      SELECT token_hash, expires_at, used_at, revoked_at
      FROM password_reset_tokens WHERE staff_user_id = ${staff.id}
      ORDER BY created_at
    `;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.token_hash).toBe(hashPasswordResetToken(firstToken));
    expect(rows[1]!.token_hash).toBe(hashPasswordResetToken(secondToken));
    expect(JSON.stringify(rows)).not.toContain(secondToken);
    expect(rows[0]!.revoked_at).toEqual(now);
    expect(rows[1]!.revoked_at).toBeNull();
    expect(rows[1]!.expires_at.getTime()).toBe(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

    now = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS + 1);
    expect(rows[1]!.expires_at < now).toBe(true);
  });
});
