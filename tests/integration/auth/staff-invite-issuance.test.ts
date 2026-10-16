import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";
import { hashStaffInviteToken, issueStaffInvite } from "@/server/services/staff-invite";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const staffId = randomUUID();

beforeAll(async () => {
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Invite Target', ${`invite-${staffId}@kleibridal.test`}, NULL, true)
  `;
});

afterAll(async () => {
  await sql`DELETE FROM password_reset_tokens WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("staff invite issuance", () => {
  it("serializes concurrent replacement and leaves one active invite", async () => {
    const issuedAt = new Date("2026-10-16T12:00:00.000Z");
    const [first, second] = await Promise.all([
      issueStaffInvite(staffId, { db, now: () => issuedAt }),
      issueStaffInvite(staffId, { db, now: () => issuedAt }),
    ]);

    expect(first?.rawToken).toHaveLength(43);
    expect(second?.rawToken).toHaveLength(43);
    expect(first?.rawToken).not.toBe(second?.rawToken);

    const tokens = await sql<
      {
        token_hash: string;
        used_at: Date | null;
        revoked_at: Date | null;
        kind: string;
      }[]
    >`
      SELECT token_hash, used_at, revoked_at, kind
      FROM password_reset_tokens
      WHERE staff_user_id = ${staffId} AND kind = 'invite'
      ORDER BY created_at
    `;
    expect(tokens).toHaveLength(2);
    const active = tokens.filter((token) => token.used_at === null && token.revoked_at === null);
    expect(active).toHaveLength(1);
    expect([
      hashStaffInviteToken(first!.rawToken),
      hashStaffInviteToken(second!.rawToken),
    ]).toContain(active[0]!.token_hash);
    expect(tokens.filter((token) => token.revoked_at !== null)).toHaveLength(1);
  });
});
