import { requireStaffPage } from "@/server/auth/page-session";

// Enquiry inbox — sorted by wedding date, gowns + chosen channel.
// Opening one writes an audit_log row. Real implementation: KBS-23.
export default async function AdminEnquiriesPage() {
  await requireStaffPage();
  return (
    <main>
      <h1>Enquiries</h1>
      <p>Admin enquiries placeholder (KBS-6) — real content lands with KBS-23.</p>
    </main>
  );
}
