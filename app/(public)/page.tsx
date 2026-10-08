// Home. Server component — SSR'd, crawlable, no "use client" at this root
// (spec/file-structure rule 1). Real content lands with the catalogue
// epic (KBS-8, KBS-10).
export default function HomePage() {
  return (
    <main>
      <h1>Klei Bridal Studio</h1>
      <p>Scaffold placeholder (KBS-6) — the catalogue and gown pages land with KBS-8 / KBS-10.</p>
    </main>
  );
}
