import type { Metadata } from "next";
import Link from "next/link";

import {
  gownFilterQuerySchema,
  gownFilterQueryString,
} from "@/shared/schemas/gownFilters";

export const dynamic = "force-dynamic";
export const revalidate = 60;

type SearchParams = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<SearchParams> };

const facets = [
  { key: "silhouette", label: "Silhouette", values: ["a-line", "ball-gown", "mermaid"] },
  { key: "material", label: "Material", values: ["lace", "satin", "tulle"] },
  { key: "collection", label: "Collection", values: ["new-arrivals", "signature"] },
] as const;

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
  const query = parsed.success ? parsed.data : undefined;
  const queryString = query ? gownFilterQueryString(query) : "";

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
          {facets.map((facet) => (
            <fieldset key={facet.key}>
              <legend>{facet.label}</legend>
              {facet.values.map((value) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    name={facet.key}
                    value={value}
                    defaultChecked={query?.[facet.key].includes(value)}
                  />
                  {value.replace("-", " ")}
                </label>
              ))}
            </fieldset>
          ))}
          <label>
            Minimum price
            <input name="price_min" inputMode="numeric" defaultValue={query?.price_min} />
          </label>
          <label>
            Maximum price
            <input name="price_max" inputMode="numeric" defaultValue={query?.price_max} />
          </label>
          <label>
            <input type="checkbox" name="available" value="1" defaultChecked={query?.available === "1"} />
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
