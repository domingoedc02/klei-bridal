"use client";

import { useEffect } from "react";
import { cacheFavouriteNames } from "@/client/favourites/storage";

/**
 * Catalogue supplies names from server-rendered records. Cache only bounded
 * id/name pairs; confirmation still treats localStorage as untrusted input.
 */
export default function FavouriteNameHydrator({
  gowns,
}: {
  gowns: Array<{ id: string; name: string }>;
}) {
  useEffect(() => {
    cacheFavouriteNames(gowns);
  }, [gowns]);
  return null;
}
