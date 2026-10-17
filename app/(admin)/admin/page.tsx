import Dashboard from "@/components/admin/Dashboard";
import { requireStaffPage } from "@/server/auth/page-session";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  await requireStaffPage();
  return <Dashboard />;
}
