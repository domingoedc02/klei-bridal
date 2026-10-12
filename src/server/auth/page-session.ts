import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/server/db/client";
import { SESSION_COOKIE, validateSession } from "@/server/auth/session";
import type { Principal } from "@/server/pipeline";

/** Authorize every admin page before it loads server data or renders PII. */
export async function requireStaffPage(): Promise<Principal> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(db, token);
  if (!session) redirect("/admin/login");
  if (session.passwordChangeRequired) redirect("/admin/change-password");
  return session;
}
