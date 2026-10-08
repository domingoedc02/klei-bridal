// Her list — "saved on this device" (localStorage only, decision/favourites-storage).
// The page itself stays server-rendered; the interactive leaf reading
// localStorage lives in src/client/favourites (KBS-14).
export default function FavouritesPage() {
  return (
    <main>
      <h1>Favourites</h1>
      <p>Favourites placeholder (KBS-6) — real content lands with KBS-14.</p>
    </main>
  );
}
