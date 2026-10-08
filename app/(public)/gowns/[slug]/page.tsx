// Gown detail — immutable slug URL, per-gown og: tags via generateMetadata
// once KBS-10/KBS-15 land. Placeholder for KBS-6.
export default async function GownDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main>
      <h1>Gown: {slug}</h1>
      <p>Gown detail placeholder (KBS-6) — real content lands with KBS-10.</p>
    </main>
  );
}
