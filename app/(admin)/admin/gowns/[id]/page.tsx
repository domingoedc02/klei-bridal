import Link from "next/link";
import { env } from "@/config/env";
import GownForm from "@/components/admin/GownForm";
import GownImages from "@/components/admin/GownImages";
import { requireStaffPage } from "@/server/auth/page-session";

export default async function AdminGownPage({ params }: { params: Promise<{ id: string }> }) {
  await requireStaffPage();
  const { id } = await params;
  const isNew = id === "new";
  return (
    <main className="admin-page">
      <p>
        <Link href="/admin/gowns">Gowns</Link>
      </p>
      <h1>{isNew ? "New gown" : "Edit gown"}</h1>
      <GownForm key={id} id={isNew ? null : id} />
      {isNew ? null : (
        <GownImages
          key={`images-${id}`}
          gownId={id}
          maxImages={env.IMAGE_MAX_PER_GOWN}
          maxBytes={env.IMAGE_MAX_UPLOAD_BYTES}
        />
      )}
    </main>
  );
}
