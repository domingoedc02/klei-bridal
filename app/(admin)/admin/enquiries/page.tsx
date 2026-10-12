import { EnquiryInbox } from "@/components/admin/EnquiryInbox";

export default function AdminEnquiriesPage() {
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
