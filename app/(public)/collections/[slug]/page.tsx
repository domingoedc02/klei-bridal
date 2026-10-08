// Collection landing page. Real content lands with KBS-8/KBS-10.
export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main>
      <h1>Collection: {slug}</h1>
      <p>Collection placeholder (KBS-6).</p>
    </main>
  );
}
