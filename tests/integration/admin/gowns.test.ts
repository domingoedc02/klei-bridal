import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db/client";
import { deleteAdminGown } from "@/server/services/admin-gowns";
import { PipelineError, type Principal } from "@/server/pipeline";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://klei:klei_dev_pw@localhost:5432/klei_dev";
const sql = postgres(DATABASE_URL, { max: 1 });

let actor: Principal;
const createdGowns: string[] = [];

beforeAll(async () => {
  const id = randomUUID();
  const email = `admin-gowns-${id}@kleibridal.test`;
  await sql`
    INSERT INTO staff_users (id, name, email, password_hash, is_active)
    VALUES (${id}, 'Admin Gowns Test', ${email}, 'not-used', true)
  `;
  actor = {
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
    staff: { id, name: "Admin Gowns Test", email },
  };
});

afterAll(async () => {
  if (createdGowns.length > 0) {
    await sql`DELETE FROM audit_log WHERE entity_id = ANY(${createdGowns})`;
    await sql`DELETE FROM gowns WHERE id = ANY(${createdGowns})`;
  }
  await sql`DELETE FROM audit_log WHERE actor_user_id = ${actor.staff.id}`;
  await sql`DELETE FROM staff_users WHERE id = ${actor.staff.id}`;
  await sql.end();
  await db.$client.end();
});

async function makeGown(status: "draft" | "published" | "archived" = "draft") {
  const id = randomUUID();
  await sql`
    INSERT INTO gowns (id, slug, name, status, created_by, updated_by)
    VALUES (${id}, ${`admin-test-${id}`}, 'Admin test gown', ${status}, ${actor.staff.id}, ${actor.staff.id})
  `;
  createdGowns.push(id);
  return id;
}

async function exists(id: string) {
  const [row] = await sql`SELECT 1 FROM gowns WHERE id = ${id}`;
  return row !== undefined;
}

function errorCode(error: unknown) {
  return error instanceof PipelineError ? error.code : undefined;
}

describe("admin gown deletion", () => {
  it("hard-deletes a draft that was never published", async () => {
    const id = await makeGown();

    await deleteAdminGown(id, actor, db);

    expect(await exists(id)).toBe(false);
  });

  it("rejects deletion of a published gown", async () => {
    const id = await makeGown("published");

    await expect(deleteAdminGown(id, actor, db)).rejects.toSatisfy(
      (error: unknown) =>
        errorCode(error) === "CONFLICT" && (error as Error).message.includes("Published"),
    );
    expect(await exists(id)).toBe(true);
  });

  it("rejects deletion of an archived gown; archive is a PATCH operation", async () => {
    const id = await makeGown("archived");

    await expect(deleteAdminGown(id, actor, db)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "CONFLICT",
    );
    expect(await exists(id)).toBe(true);
  });
});
