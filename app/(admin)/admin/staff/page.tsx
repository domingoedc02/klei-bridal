import { requireStaffPage } from "@/server/auth/page-session";

// Named staff accounts — create, disable (never delete), reset password.
// Real implementation: KBS-24.
export default async function AdminStaffPage() {
  await requireStaffPage();
  return (
    <main>
      <h1>Staff</h1>
      <p>Admin staff placeholder (KBS-6) — real content lands with KBS-24.</p>
    </main>
  );
}
