import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";

import { hashPassword } from "@/server/auth/password";
import { assertPasswordAllowed } from "@/server/auth/password-policy";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { db as defaultDb, type Database } from "@/server/db/client";
import { auditLog, staffUsers } from "@/server/db/schema";
import { issueStaffInvite } from "@/server/services/staff-invite";
import type { Principal } from "@/server/pipeline";
import { PipelineError } from "@/server/pipeline/errors";
import { inetOrNull } from "@/server/ratelimit/client-ip";
import type { StaffCreate, StaffPatch } from "@/shared/schemas/staffAdmin";

const TEMP_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;

const columns = {
  id: staffUsers.id,
  name: staffUsers.name,
  email: staffUsers.email,
  isActive: staffUsers.isActive,
  tempPasswordExpiresAt: staffUsers.tempPasswordExpiresAt,
  lastSignInAt: staffUsers.lastSignInAt,
  createdAt: staffUsers.createdAt,
};
type Row = { [K in keyof typeof columns]: (typeof staffUsers.$inferSelect)[K] };

/** Never the hash or expiry value. */
const toJson = (r: Row, now = new Date()) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  is_active: r.isActive,
  password_change_pending: Boolean(r.tempPasswordExpiresAt && r.tempPasswordExpiresAt > now),
  last_sign_in_at: r.lastSignInAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
});

export async function createStaff(
  input: StaffCreate,
  actor: Principal,
  ip: string | null,
  db: Database = defaultDb,
) {
  const email = input.email.trim().toLowerCase();
  const now = new Date();

  return db
    .transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(sql`lower(${staffUsers.email}) = ${email}`)
        .limit(1);
      if (existing) throw new PipelineError(409, "CONFLICT", "This email is already in use.");

      const [created] = await tx
        .insert(staffUsers)
        .values({
          name: input.name.trim(),
          email,
          passwordHash: null,
          tempPasswordExpiresAt: null,
        })
        .returning(columns);
      if (!created) throw new Error("staff insert returned no row");

      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "staff.create",
        entityType: "staff_user",
        entityId: created.id,
        // Staff email is personal data; entityId already identifies this audit target.
        detail: {},
        ip: inetOrNull(ip),
      });
      return toJson(created, now);
    })
    .then(async (created) => {
      const invite = await issueStaffInvite(created.id, { db, now: () => now });
      if (!invite) throw new PipelineError(404, "NOT_FOUND", "Staff account not found.");
      return { ...created, password_change_pending: false };
    });
}

/** GET /admin/staff (KBS-24-1): a studio of 2–5 people, so one unpaged list, active first. */
export async function listStaff(db: Database = defaultDb) {
  const rows = await db
    .select(columns)
    .from(staffUsers)
    .orderBy(desc(staffUsers.isActive), asc(staffUsers.name));
  return { items: rows.map((row) => toJson(row)) };
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
  if (patch.password !== undefined && (patch.name !== undefined || patch.is_active !== undefined)) {
    throw new PipelineError(
      422,
      "VALIDATION_ERROR",
      "Password reset cannot be combined with account changes.",
    );
  }
  if (patch.password !== undefined) {
    const policy = await assertPasswordAllowed(patch.password);
    if (!policy.ok) {
      if (policy.reason === "weak_password") {
        throw new PipelineError(422, "VALIDATION_ERROR", "Check the highlighted fields.", {
          fields: { password: "Choose a longer password." },
        });
      }
      if (policy.reason === "password_too_common") {
        throw new PipelineError(422, "PASSWORD_TOO_COMMON", "Choose a less common password.", {
          fields: { password: "Choose a less common password." },
        });
      }
      throw new PipelineError(
        503,
        "SERVICE_UNAVAILABLE",
        "Password policy is temporarily unavailable.",
      );
    }
    const passwordHash = await hashPassword(patch.password);
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select(columns)
        .from(staffUsers)
        .where(eq(staffUsers.id, id))
        .for("update");
      if (!row) throw new PipelineError(404, "NOT_FOUND", "Staff account not found.");
      if (!row.isActive)
        throw new PipelineError(
          422,
          "VALIDATION_ERROR",
          "Disabled accounts must be re-enabled first.",
        );
      const now = new Date();
      const expiresAt = new Date(now.getTime() + TEMP_PASSWORD_TTL_MS);
      const [updated] = await tx
        .update(staffUsers)
        .set({
          passwordHash,
          tempPasswordExpiresAt: expiresAt,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(staffUsers.id, id))
        .returning(columns);
      const revokedSessions = await revokeAllSessionsForUser(tx, id, now);
      await tx.insert(auditLog).values({
        occurredAt: now,
        actorUserId: actor.staff.id,
        action: "staff.password_reset",
        entityType: "staff_user",
        entityId: id,
        detail: {},
        ip: inetOrNull(ip),
      });
      return { ...toJson(updated!), revoked_sessions: revokedSessions };
    });
  }

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
