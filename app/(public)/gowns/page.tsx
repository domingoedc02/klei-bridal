import type { Metadata } from "next";
import Link from "next/link";

import {
  gownFilterQuerySchema,
  gownFilterQueryString,
} from "@/shared/schemas/gownFilters";

// SSR remains the source of truth. Middleware adds short-TTL HTTP caching while
// filter state stays in the URL and works with JavaScript disabled.
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
  const query = parsed.success ? parsed.data : undefined;
  const queryString = query ? gownFilterQueryString(query) : "";

  return (
    <main>
      <h1>Gowns</h1>
      {query ? (
        <p data-filter-query={queryString}>
          Browse gowns{queryString ? ` matching ${queryString}` : ""}.
        </p>
      ) : (
        <p role="alert">
          We couldn&apos;t read these filters. <Link href="/gowns">Reset filters</Link>.
        </p>
      )}
      <form method="get" action="/gowns">
        <label>
          Search <input name="q" defaultValue={query?.q} maxLength={80} />
        </label>
        <label>
          Minimum price <input name="price_min" inputMode="numeric" defaultValue={query?.price_min} />
        </label>
        <label>
          Maximum price <input name="price_max" inputMode="numeric" defaultValue={query?.price_max} />
        </label>
        <label>
          <input type="checkbox" name="available" value="1" defaultChecked={query?.available === "1"} /> Available now
        </label>
        <button type="submit">Apply filters</button>
      </form>
    </main>
  );
}
