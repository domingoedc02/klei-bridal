import { z } from "zod";

/**
 * Gown ids from the bride's browser (favourites, enquiry, send-my-list).
 * Shape only: localStorage is hers to edit, so every write re-checks the
 * ids against the database with `requirePublishedGowns` (KBS-11-3,
 * decision/favourites-storage). Max 50 — a shortlist, not the catalogue.
 */
export const gownIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(50)
  .transform((ids) => [...new Set(ids)]);
