import "server-only";
import { asc, desc, eq } from "drizzle-orm";

import { revokeAllSessionsForUser } from "@/server/auth/session";
import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, staffUsers } from "@/server/db/schema";
import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import type { StaffPatch } from "@/shared/schemas/staffAdmin";

const columns = {
  id: staffUsers.id,
  name: staffUsers.name,
  email: staffUsers.email,
  isActive: staffUsers.isActive,
  lastSignInAt: staffUsers.lastSignInAt,
  createdAt: staffUsers.createdAt,
};
type Row = { [K in keyof typeof columns]: (typeof staffUsers.$inferSelect)[K] };

/** Never the hash, lock state or failure count. */
const toJson = (r: Row) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  is_active: r.isActive,
  last_sign_in_at: r.lastSignInAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
});

/** GET /admin/staff (KBS-24-1): a studio of 2–5 people, so one unpaged list, active first. */
export async function listStaff(db: Database = defaultDb) {
  const rows = await db
    .select(columns)
    .from(staffUsers)
    .orderBy(desc(staffUsers.isActive), asc(staffUsers.name));
  return { items: rows.map(toJson) };
}

/**
 * PATCH /admin/staff/:id (KBS-24-1). Disable revokes every live session in
 * the same transaction (the `is_active` join already locks them out; revoking
 * means a later re-enable does not revive old cookies). Refused with 409:
 * disabling yourself, and disabling the last active account. Every active
 * row is locked first, so two concurrent disables cannot both see "one
 * other active" and leave nobody. Audit detail carries no names.
 */
export async function updateStaff(
  id: string,
  patch: StaffPatch,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  return db.transaction(async (tx) => {
    const active = await tx
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(staffUsers.isActive, true))
      .for("update");
    const [row] = await tx
      .select(columns)
      .from(staffUsers)
      .where(eq(staffUsers.id, id))
      .for("update");
    if (!row) throw new PipelineError(404, "NOT_FOUND", "Staff account not found.");

    const now = new Date();
    const audit = (action: string) =>
      tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action,
        entityType: "staff_user",
        entityId: id,
        detail: {},
        ip: inetOrNull(ip),
      });

    if (patch.is_active === false && row.isActive) {
      if (id === actor.staff.id) {
        throw new PipelineError(409, "CONFLICT", "You cannot disable your own account.");
      }
      if (active.length <= 1) {
        throw new PipelineError(409, "CONFLICT", "The last active account cannot be disabled.");
      }
    }

    const changes: Partial<typeof staffUsers.$inferInsert> = {};
    if (patch.name !== undefined && patch.name !== row.name) changes.name = patch.name;
    if (patch.is_active !== undefined && patch.is_active !== row.isActive) {
      changes.isActive = patch.is_active;
    }
    if (!Object.keys(changes).length) return toJson(row);

    const [updated] = await tx
      .update(staffUsers)
      .set({ ...changes, updatedAt: now })
      .where(eq(staffUsers.id, id))
      .returning(columns);
    if (changes.name !== undefined) await audit("staff.rename");
    if (changes.isActive === false) {
      await revokeAllSessionsForUser(tx, id, now);
      await audit("staff.disable");
    }
    if (changes.isActive === true) await audit("staff.enable");
    return toJson(updated!);
  });
}
