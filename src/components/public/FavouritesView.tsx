"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  clearContactDetails,
  getContactDetails,
  getFavouriteIds,
} from "@/client/favourites/storage";

type Gown = { id: string; slug: string; name: string; image?: string | null };

export default function FavouritesView({ gowns }: { gowns: Gown[] }) {
  const [ids, setIds] = useState<string[]>([]);
  const [detailsCleared, setDetailsCleared] = useState(false);

  useEffect(() => {
    const sync = () => setIds(getFavouriteIds());
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const saved = useMemo(() => {
    const allowed = new Set(gowns.map((gown) => gown.id));
    return ids
      .filter((id) => allowed.has(id))
      .map((id) => gowns.find((gown) => gown.id === id)!)
      .filter(Boolean);
  }, [gowns, ids]);

  function clearDetails() {
    clearContactDetails();
    setDetailsCleared(true);
  }

  return (
    <main>
      <h1>Favourites</h1>
      <p>Your list is saved on this device.</p>
      <p>
        <Link href="/enquire">Send my list</Link>
      </p>
      {saved.length === 0 ? (
        <section aria-live="polite">
          <h2>Your shortlist is empty</h2>
          <p>Tap the heart on any gown to save it here.</p>
          <Link href="/gowns">Browse gowns</Link>
        </section>
      ) : (
        <ul aria-label="Saved gowns">
          {saved.map((gown) => (
            <li key={gown.id}>
              <Link href={`/gowns/${gown.slug}`}>
                {gown.image ? <img src={gown.image} alt="" width={240} height={320} /> : null}
                {gown.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="clear-details-heading">
        <h2 id="clear-details-heading">Remembered contact details</h2>
        <p>{detailsCleared ? "Your remembered details are cleared." : getContactDetails().email ? "Details saved on this device." : "No contact details saved."}</p>
        <button type="button" onClick={clearDetails}>Clear my details</button>
      </section>
    </main>
  );
}
