import "server-only";
import { sql } from "drizzle-orm";

import { enquiries } from "@/server/db/schema";

/**
 * The one erased marker (spec/api/admin-enquiries): `email` is required on
 * submit, so only erasure leaves it null. Use this everywhere (list, detail,
 * 409s, the helper, /e/<token>); never re-implement it inline.
 * ponytail: breaks if email ever becomes optional on submit; then add an
 * `erased_at timestamptz` column and point this at it.
 */
export const isErased = sql<boolean>`(${enquiries.email} IS NULL)`;
