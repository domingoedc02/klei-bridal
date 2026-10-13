import type { Metadata } from "next";
import Link from "next/link";

import { gownFilterQuerySchema, gownFilterQueryString } from "@/shared/schemas/gownFilters";

export const dynamic = "force-dynamic";
export const revalidate = 60;

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const raw = await searchParams;
  const parsed = gownFilterQuerySchema.safeParse(raw);
  const query = parsed.success ? gownFilterQueryString(parsed.data) : "";
  return {
    title: "Gowns",
    alternates: { canonical: `/gowns${query ? `?${query}` : ""}` },
  };
}

export default async function GownsPage({ searchParams }: Props) {
  const raw = await searchParams;
  const parsed = gownFilterQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return (
      <main>
        <h1>Gowns</h1>
        <p role="alert">INVALID_QUERY</p>
        <Link href="/gowns">Reset filters</Link>
      </main>
    );
  }
  const query = parsed.data;
  const queryString = gownFilterQueryString(query);

  return (
    <main>
      <h1>Gowns</h1>
      <p>Find a gown by shape, material, collection, or price.</p>
      {query ? (
        <p data-filter-query={queryString}>
          {queryString ? `Active filters: ${queryString}` : "Showing all gowns."}
        </p>
      ) : (
        <p role="alert">
          We couldn&apos;t read these filters. <Link href="/gowns">Reset filters</Link>.
        </p>
      )}

      <form method="get" action="/gowns">
        <fieldset>
          <legend>Search</legend>
          <label>
            Search gowns
            <input name="q" defaultValue={query?.q} maxLength={80} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Filter gowns</legend>
          <p>
            Use silhouette, material, or collection slugs in the URL. Active vocabulary options load
            from the catalogue data.
          </p>
          <label>
            Minimum price
            <input name="price_min" inputMode="numeric" defaultValue={query?.price_min} />
          </label>
          <label>
            Maximum price
            <input name="price_max" inputMode="numeric" defaultValue={query?.price_max} />
          </label>
          <label>
            <input
              type="checkbox"
              name="available"
              value="1"
              defaultChecked={query?.available === "1"}
            />
            Available now
          </label>
          <label>
            Sort
            <select name="sort" defaultValue={query?.sort ?? "newest"}>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
            </select>
          </label>
          <button type="submit">Apply filters</button>
          <Link href="/gowns">Clear all</Link>
        </fieldset>
      </form>
    </main>
  );
}
