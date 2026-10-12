import { EnquiryDetailView } from "@/components/admin/EnquiryInbox";

export default async function AdminEnquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="admin-page">
      <EnquiryDetailView id={id} />
    </main>
  );
}
