import { requireStaffPage } from "@/server/auth/page-session";

// Dashboard: this month / last month, source split, chat-channel split,
// unread + oldest unread. Real content: KBS-26.
export default async function AdminDashboardPage() {
  await requireStaffPage();
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Admin dashboard placeholder (KBS-6) — real content lands with KBS-26.</p>
    </main>
  );
}
