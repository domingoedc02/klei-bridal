import { GownList } from "@/components/admin/GownForm";
import { requireStaffPage } from "@/server/auth/page-session";

export default async function AdminGownsPage() {
  await requireStaffPage();
  return (
    <main className="admin-page">
      <h1>Gowns</h1>
      <GownList />
    </main>
  );
}
