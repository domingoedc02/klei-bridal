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
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const deps = { db, sendEmail };

    const unknown = await requestPasswordReset(
      { email: `nobody-${randomUUID()}@kleibridal.test` },
      deps,
    );
    const off = await requestPasswordReset({ email: disabled.email }, deps);
    const found = await requestPasswordReset({ email: active.email }, deps);

    expect(unknown).toEqual({ accepted: true });
    expect(off).toEqual(unknown);
    expect(found).toEqual(unknown);
    expect(sendEmail).toHaveBeenCalledTimes(1);
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
    await requestPasswordReset({ email: staff.email }, deps);
    expect(sent).toHaveLength(2);

    const firstRaw = /token=([^\\s]+)/.exec(sent[0]!.text)![1]!;
    const secondRaw = /token=([^\\s]+)/.exec(sent[1]!.text)![1]!;
    const rows = await sql<
      { token_hash: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }[]
    >`
      SELECT token_hash, expires_at, used_at, revoked_at
      FROM password_reset_tokens WHERE staff_user_id = ${staff.id}
      ORDER BY created_at
    `;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.token_hash).toBe(hashPasswordResetToken(decodeURIComponent(firstRaw)));
    expect(rows[1]!.token_hash).toBe(hashPasswordResetToken(decodeURIComponent(secondRaw)));
    expect(JSON.stringify(rows)).not.toContain(decodeURIComponent(secondRaw));
    expect(rows[0]!.revoked_at).toEqual(now);
    expect(rows[1]!.revoked_at).toBeNull();
    expect(rows[1]!.expires_at.getTime()).toBe(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

    now = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS + 1);
    expect(rows[1]!.expires_at < now).toBe(true);
  });
});
