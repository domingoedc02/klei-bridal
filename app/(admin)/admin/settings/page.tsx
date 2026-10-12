import { requireStaffPage } from "@/server/auth/page-session";

// Lead-time window + notice copy, studio handles, UTM link generator.
// Real implementation: KBS-25.
export default async function AdminSettingsPage() {
  await requireStaffPage();
  return (
    <main>
      <h1>Settings</h1>
      <p>Admin settings placeholder (KBS-6) — real content lands with KBS-25.</p>
    </main>
  );
}
