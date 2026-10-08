// Catalogue. Filters are read from `searchParams` server-side so a
// filtered view is shareable, crawlable and works with JS disabled
// (decision/rendering). Real implementation: KBS-8.
export default function GownsPage() {
  return (
    <main>
      <h1>Gowns</h1>
      <p>Catalogue placeholder (KBS-6) — filtering lands with KBS-8.</p>
    </main>
  );
}
