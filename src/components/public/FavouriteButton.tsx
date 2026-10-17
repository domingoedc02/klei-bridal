"use client";

import { useEffect, useState } from "react";
import {
  addFavourite,
  getFavouriteIds,
  removeFavourite,
} from "@/client/favourites/storage";

type Props = { gownId: string; gownName: string };

export default function FavouriteButton({ gownId, gownName }: Props) {
  const [saved, setSaved] = useState<boolean | null>(null);

  useEffect(() => {
    const sync = () => setSaved(getFavouriteIds().includes(gownId));
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [gownId]);

  function toggle() {
    if (saved) removeFavourite(gownId);
    else addFavourite(gownId);
    setSaved(!saved);
  }

  return (
    <button
      type="button"
      aria-label={saved ? `Remove ${gownName} from favourites` : `Add ${gownName} to favourites`}
      aria-pressed={saved === true}
      onClick={toggle}
      disabled={saved === null}
      style={{ minWidth: 44, minHeight: 44 }}
    >
      <span aria-hidden="true">{saved ? "♥" : "♡"}</span>
    </button>
  );
}
