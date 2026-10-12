import { requireStaffPage } from "@/server/auth/page-session";
import { EnquiryInbox } from "@/components/admin/EnquiryInbox";

export default async function AdminEnquiriesPage() {
  await requireStaffPage();
  return (
    <main className="admin-page">
      <h1>Enquiries</h1>
      <p className="page-intro">
        Prioritised by wedding date. Open detail to see snapshots and reply outside admin.
      </p>
      <EnquiryInbox />
    </main>
  );
}
