import { requireStaffPage } from "@/server/auth/page-session";
import { getAdminSettings } from "@/server/services/admin-settings";
import SettingsForm from "@/components/admin/SettingsForm";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  await requireStaffPage();
  const settings = await getAdminSettings();
  return <SettingsForm initial={settings} />;
}
