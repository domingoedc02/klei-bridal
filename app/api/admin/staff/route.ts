import { withPipeline } from "@/server/pipeline";
import { listStaff } from "@/server/services/admin-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Staff names and emails are personal data: never cached.
async function get() {
  return Response.json(await listStaff(), { headers: { "cache-control": "no-store" } });
}

// ponytail: POST (create) waits on the initial-password decision (KBS-24-1, team-lead).
export const GET = withPipeline(get, { auth: "staff", rateLimit: null });
