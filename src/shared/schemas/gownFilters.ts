import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9-]{1,80}$/);
const optionalText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(80).optional(),
);
const optionalWholePeso = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.union([
    z.number().int().min(0).max(9_999_999),
    z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(9_999_999)),
  ]).optional(),
);
const repeatableSlug = z
  .union([slug, z.array(slug).max(20)])
  .optional()
  .transform((value) => (value === undefined ? [] : Array.isArray(value) ? [...new Set(value)] : [value]));

/** Canonical server-side query contract for `/gowns` (spec/api/catalogue). */
export const gownFilterQuerySchema = z
  .object({
    q: optionalText,
    silhouette: repeatableSlug,
    material: repeatableSlug,
    collection: repeatableSlug,
    available: z.preprocess(
      (value) => (value === undefined || value === "" ? undefined : value),
      z.literal("1").optional(),
    ),
    price_min: optionalWholePeso,
    price_max: optionalWholePeso,
    sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),
    page: z.coerce.number().int().min(1).max(1000).default(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.price_min !== undefined && value.price_max !== undefined && value.price_min > value.price_max) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["price_min"], message: "price_min must not exceed price_max" });
    }
  });

export type GownFilterQuery = z.infer<typeof gownFilterQuerySchema>;

/** Parse Next.js `searchParams`; malformed values become INVALID_QUERY at the route boundary. */
export function parseGownFilterQuery(
  searchParams: Record<string, string | string[] | undefined>,
): GownFilterQuery {
  return gownFilterQuerySchema.parse(searchParams);
}

/** Stable query string for canonical links, cache keys and no-JS pagination links. */
export function gownFilterQueryString(query: GownFilterQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  for (const key of ["silhouette", "material", "collection"] as const) {
    for (const value of [...query[key]].sort()) params.append(key, value);
  }
  if (query.available) params.set("available", query.available);
  if (query.price_min !== undefined) params.set("price_min", String(query.price_min));
  if (query.price_max !== undefined) params.set("price_max", String(query.price_max));
  if (query.sort !== "newest") params.set("sort", query.sort);
  if (query.page !== 1) params.set("page", String(query.page));
  return params.toString();
}
