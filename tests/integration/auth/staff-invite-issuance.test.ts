import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as createStaff } from "../../../app/api/admin/staff/route";
import { db } from "@/server/db/client";
import { hashStaffInviteToken, issueStaffInvite } from "@/server/services/staff-invite";

/** KBS-123-1: invite issuance is serialised per staff row, and the route is staff-only. */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });
const staffId = randomUUID();
const anonEmail = `anon-invite-${randomUUID()}@kleibridal.test`;

beforeAll(async () => {
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${staffId}, 'Invite Target', ${`invite-${staffId}@kleibridal.test`}, NULL, true)
  `;
});

afterAll(async () => {
  await sql`DELETE FROM staff_mail_outbox WHERE token_id IN
    (SELECT id FROM password_reset_tokens WHERE staff_user_id = ${staffId})`;
  await sql`DELETE FROM password_reset_tokens WHERE staff_user_id = ${staffId}`;
  await sql`DELETE FROM audit_log WHERE entity_id = ${staffId}`;
  await sql`DELETE FROM staff_users WHERE id = ${staffId}`;
  await sql.end();
  await db.$client.end();
});

describe("staff invite issuance (KBS-123-1)", () => {
  it("serialises concurrent issuance: one active invite, one live outbox row, old mail cancelled", async () => {
    const issuedAt = new Date();
    const [first, second] = await Promise.all([
      issueStaffInvite(staffId, { db, now: () => issuedAt }),
      issueStaffInvite(staffId, { db, now: () => issuedAt }),
    ]);

    expect(first?.rawToken).toHaveLength(43);
    expect(second?.rawToken).toHaveLength(43);
    expect(first?.rawToken).not.toBe(second?.rawToken);

    const tokens = await sql<
      { id: string; token_hash: string; used_at: Date | null; revoked_at: Date | null }[]
    >`
      SELECT id, token_hash, used_at, revoked_at FROM password_reset_tokens
      WHERE staff_user_id = ${staffId} AND kind = 'invite' ORDER BY created_at, id
    `;
    expect(tokens).toHaveLength(2);
    const active = tokens.filter((t) => t.used_at === null && t.revoked_at === null);
    expect(active).toHaveLength(1);
    expect([
      hashStaffInviteToken(first!.rawToken),
      hashStaffInviteToken(second!.rawToken),
    ]).toContain(active[0]!.token_hash);

    // The superseded token's pending mail is cancelled; only the live token can still be delivered.
    const outbox = await sql<{ token_id: string; status: string; payload: Buffer | null }[]>`
      SELECT token_id, status, payload FROM staff_mail_outbox
      WHERE token_id = ANY(${tokens.map((t) => t.id)})
    `;
    expect(outbox).toHaveLength(2);
    const live = outbox.filter((o) => o.status === "pending");
    expect(live).toHaveLength(1);
    expect(live[0]!.token_id).toBe(active[0]!.id);
    const dead = outbox.find((o) => o.token_id !== active[0]!.id)!;
    expect(dead).toMatchObject({ status: "cancelled", payload: null });
  });

  it("route: no session creates no staff row, token or outbox mail", async () => {
    const res = await createStaff(
      new NextRequest("http://localhost:3000/api/admin/staff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Unauthorised Person", email: anonEmail }),
      }),
      {} as never,
    );
    expect(res.status).toBe(401);
    expect(await sql`SELECT id FROM staff_users WHERE email = ${anonEmail}`).toHaveLength(0);
    expect(
      await sql`SELECT t.id FROM password_reset_tokens t
        JOIN staff_users s ON s.id = t.staff_user_id WHERE s.email = ${anonEmail}`,
    ).toHaveLength(0);
  });
});
